"""合成数据行为回归；不读取验收目录，不访问真实网络或完整上游数据库。"""
import argparse
from contextlib import redirect_stdout
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('converter', Path(__file__).with_name('convert.py'))
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)


class ConversionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.image = b'synthetic image fixture'
        cls.dictionaries = {key: [{'dictCode': '1', 'dictValue': '草'}]
                            for key in ['attribute', 'ability_cost', 'weakness_type', 'resistance_type']}
        cls.normalized_dict = {key: {'1': '草'} for key in cls.dictionaries}
        references = []
        cls.rows = []
        entries = []
        for index in [1, 2]:
            reference = {'id': f'test-{index}', 'name': 'Example ex' if index == 1 else 'Evolved Example',
                         'number': str(index), 'supertype': 'Pokémon',
                         'subtypes': ['Basic' if index == 1 else 'Stage 1'],
                         'hp': '180', 'types': ['Grass'], 'retreatCost': ['Colorless'],
                         'attacks': [{'name': 'Synthetic Hit', 'cost': ['Grass'], 'damage': '10',
                                      'text': 'Synthetic effect.'}]}
            if index == 2:
                reference['evolvesFrom'] = 'Example ex'
            record = {'id': f'cn-test-{index}', 'name': '合成基础' if index == 1 else '合成进化',
                      'commodityCode': 'TEST', 'image': f'images/test-{index}.png',
                      'details': {'collectionNumber': str(index), 'cardType': '1', 'hp': 180,
                                  'attribute': '1', 'evolveText': '基础' if index == 1 else '1阶进化',
                                  'retreatCost': 1, 'ruleText': '合成规则说明', 'cardFeatureItemList': [],
                                  'abilityItemList': [{'abilityName': '合成招式', 'abilityCost': '1',
                                                       'abilityDamage': '10', 'abilityText': '合成效果'}]}}
            entry = {'input': {'set': 'TST', 'number': str(index), 'name': reference['name']},
                     'source': {'name': record['name'], 'set': 'TEST', 'number': str(index),
                                'id': record['id'], 'image': record['image'], 'sha256': converter.fingerprint(record)},
                     'reference': {'id': reference['id'], 'sha256': converter.fingerprint(reference)},
                     'supplements': {} if index == 1 else {'evolvesFrom': '合成基础'},
                     'reviewed': True, 'evidence': {'imageSha256': converter.digest(cls.image)}}
            references.append(reference)
            cls.rows.append(record)
            entries.append(entry)
        cls.english_raw = json.dumps(references).encode()
        cls.dataset_raw = json.dumps({'dict': cls.dictionaries, 'collections': [{'cards': cls.rows}]}).encode()
        cls.catalog = {'dataset': {'repository': converter.REPOSITORY, 'commit': 'a' * 40,
                                   'sha256': converter.digest(cls.dataset_raw)},
                       'englishReference': {'repository': 'https://github.com/PokemonTCG/pokemon-tcg-data',
                                            'commit': 'b' * 40, 'sets': [{'id': 'test', 'ptcgoCode': 'TST'}]},
                       'entries': entries}
        cls.basic = {**entries[0], 'reference': references[0]}

    def test_live_sections_preserve_order_and_counts(self):
        rows = converter.parse_export('\ufeff# 卡组 ID\nPokémon: 1\n2 Example ex TST 1\n'
                                      'Energy (1)\n4 Grass Energy SVE 1\nTotal Cards: 6')
        self.assertEqual([(row['name'], row['count']) for row in rows], [('Example ex', 2), ('Grass Energy', 4)])

    def test_unusable_exports_are_rejected(self):
        for raw in ['# 小程序卡组ID: abc', '0 Example ex TST 1', '说明：换几张牌',
                    '1 Example ex TST 1\nTotal Cards: 60']:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                converter.parse_export(raw)

    def test_aliases_handle_accents_without_changing_identity(self):
        self.assertEqual(converter.normalize_name('Poké Pad'), converter.normalize_name('Poke Pad'))
        self.assertEqual(converter.card_key('tst', '0001'), ('TST', '1'))
        self.assertNotEqual(converter.normalize_name('Example'), converter.normalize_name('Example ex'))

    def test_changed_source_record_is_rejected(self):
        original = converter.select_source(self.rows, self.basic)
        changed = deepcopy(original)
        changed['details']['hp'] = 160
        with self.assertRaises(ValueError):
            converter.select_source([changed], self.basic)

    def test_ambiguous_print_is_rejected(self):
        original = converter.select_source(self.rows, self.basic)
        variant = deepcopy(original)
        variant['details']['ruleText'] += '变更'
        with self.assertRaises(ValueError):
            converter.select_source([original, variant], self.basic)

    def test_basic_hp_mismatch_is_rejected(self):
        record = converter.select_source(self.rows, self.basic)
        card = converter.convert_card(record, self.basic, self.normalized_dict, self.catalog['dataset']['commit'])
        self.assertEqual(card['hp'], 180)
        card['hp'] = 160
        with self.assertRaises(ValueError):
            converter.check_reference(card, self.basic, {}, self.catalog['englishReference']['sets'])

    def test_evolution_requires_reviewed_source(self):
        entry = deepcopy(next(entry for entry in self.catalog['entries'] if entry['input']['name'] == 'Evolved Example'))
        entry['supplements'] = {}
        with self.assertRaisesRegex(ValueError, '进化来源'):
            converter.convert_card(converter.select_source(self.rows, entry), entry,
                                   self.normalized_dict, self.catalog['dataset']['commit'])

    def test_dynamic_cost_is_not_fabricated(self):
        record = deepcopy(converter.select_source(self.rows, self.basic))
        record['details']['abilityItemList'][0]['abilityCost'] = '12'
        with self.assertRaisesRegex(ValueError, '动态费用'):
            converter.convert_card(record, self.basic, self.normalized_dict, self.catalog['dataset']['commit'])

    def test_unknown_and_wrong_identity_never_output_a_deck(self):
        with tempfile.TemporaryDirectory(prefix='ptcg-skill-guards-') as tmp:
            base = Path(tmp)
            dataset = base / 'dataset.json'
            dataset.write_text(json.dumps({'dict': self.dictionaries, 'collections': [{'cards': self.rows}]}))
            catalog = deepcopy(self.catalog)
            catalog['dataset']['sha256'] = converter.digest(dataset.read_bytes())
            catalog_path = base / 'catalog.json'
            catalog_path.write_text(json.dumps(catalog))
            for index, raw in enumerate(['1 Example ex ZZZ 1', '1 Other TST 1']):
                source = base / f'source-{index}.txt'
                source.write_text(raw)
                work = base / f'run-{index}'
                args = argparse.Namespace(input=source, dataset=dataset, catalog=catalog_path,
                                          dataset_commit=None, cache_dir=base / 'cache', refresh=False,
                                          name='测试', expected_total=1, work_dir=work)
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(converter.convert(args), 2)
                self.assertTrue((work / 'pending.json').is_file())
                self.assertEqual((work / 'source.txt').read_text(), raw)
                self.assertFalse((work / 'deck.json').exists())
                with self.assertRaises(FileExistsError), redirect_stdout(io.StringIO()):
                    converter.convert(args)

    def test_snapshot_mismatch_stops_before_output(self):
        with tempfile.TemporaryDirectory(prefix='ptcg-skill-snapshot-') as tmp:
            base = Path(tmp)
            dataset = base / 'dataset.json'
            dataset.write_text(json.dumps({'dict': self.dictionaries, 'collections': [{'cards': self.rows}]}))
            source = base / 'source.txt'
            source.write_text('1 Example ex TST 1')
            args = argparse.Namespace(input=source, dataset=dataset, catalog=converter.DEFAULT_CATALOG,
                                      dataset_commit=None, cache_dir=base / 'cache', refresh=False,
                                      name='测试', expected_total=1, work_dir=base / 'run')
            with self.assertRaisesRegex(ValueError, '散列'):
                converter.convert(args)
            self.assertFalse(args.work_dir.exists())

    def automatic_args(self, tmp):
        base = Path(tmp)
        source = base / 'source.txt'
        source.write_text('1 Example ex TST 1')
        catalog = base / 'catalog.json'
        converter.write_json(catalog, self.catalog)
        return argparse.Namespace(input=source, dataset=None, dataset_commit=None,
                                  cache_dir=base / 'cache', refresh=False, catalog=catalog,
                                  name='合成测试', expected_total=1, work_dir=base / 'run')

    def upstream(self, url):
        if url == converter.LATEST_COMMIT:
            return json.dumps({'sha': self.catalog['dataset']['commit']}).encode()
        if url.endswith('/cards/en/test.json'):
            return self.english_raw
        return self.dataset_raw if url.endswith('/ptcg_chs_infos.json') else self.image

    def run_conversion(self, args):
        with redirect_stdout(io.StringIO()):
            return converter.convert(args)

    def test_cold_cache_downloads_latest_then_runs_offline(self):
        with tempfile.TemporaryDirectory(prefix='ptcg-skill-cache-') as tmp:
            args = self.automatic_args(tmp)
            with patch.object(converter, 'fetch_bytes', side_effect=self.upstream) as fetch:
                self.assertEqual(self.run_conversion(args), 0)
                self.assertEqual(fetch.call_count, 4)
            report = json.loads((args.work_dir / 'conversion.json').read_text())
            self.assertEqual(report['dataset'], self.catalog['dataset'])
            self.assertEqual(report['mapping'][0]['evidence']['imageSha256'], converter.digest(self.image))
            args.work_dir = Path(tmp) / 'offline-run'
            with patch.object(converter, 'fetch_bytes', side_effect=AssertionError('离线不得请求网络')):
                self.assertEqual(self.run_conversion(args), 0)

    def test_refresh_accepts_unrelated_additions_and_records_actual_commit(self):
        with tempfile.TemporaryDirectory(prefix='ptcg-skill-refresh-') as tmp:
            args = self.automatic_args(tmp)
            with patch.object(converter, 'fetch_bytes', side_effect=self.upstream):
                self.assertEqual(self.run_conversion(args), 0)
            data = json.loads(self.dataset_raw)
            data['collections'].append({'cards': []})
            updated = json.dumps(data).encode()
            commit = 'b' * 40
            def latest(url):
                if url == converter.LATEST_COMMIT:
                    return json.dumps({'sha': commit}).encode()
                return updated if url.endswith('/ptcg_chs_infos.json') else self.image
            args.refresh = True
            args.work_dir = Path(tmp) / 'refreshed'
            with patch.object(converter, 'fetch_bytes', side_effect=latest):
                self.assertEqual(self.run_conversion(args), 0)
            report = json.loads((args.work_dir / 'conversion.json').read_text())
            self.assertEqual(report['dataset']['commit'], commit)
            self.assertEqual(report['dataset']['sha256'], converter.digest(updated))
            self.assertIn(commit, json.loads((args.work_dir / 'deck.json').read_text())['cards'][0]['card']['imageUrl'])

    def test_changed_latest_record_is_pending(self):
        with tempfile.TemporaryDirectory(prefix='ptcg-skill-changed-') as tmp:
            args = self.automatic_args(tmp)
            data = json.loads(self.dataset_raw)
            record = next(row for row in data['collections'][0]['cards'] if row['name'] == self.basic['source']['name'])
            record['details']['hp'] = 160
            def latest(url):
                return json.dumps({'sha': 'b' * 40}).encode() if url == converter.LATEST_COMMIT else json.dumps(data).encode()
            with patch.object(converter, 'fetch_bytes', side_effect=latest):
                self.assertEqual(self.run_conversion(args), 2)
            self.assertFalse((args.work_dir / 'deck.json').exists())

    def test_changed_image_is_pending(self):
        with tempfile.TemporaryDirectory(prefix='ptcg-skill-image-') as tmp:
            args = self.automatic_args(tmp)
            def changed(url):
                return b'changed image' if url.endswith('.png') else self.upstream(url)
            with patch.object(converter, 'fetch_bytes', side_effect=changed):
                self.assertEqual(self.run_conversion(args), 2)
            self.assertFalse((args.work_dir / 'deck.json').exists())
            self.assertIn('卡图散列', (args.work_dir / 'pending.json').read_text())

    def test_corrupt_cache_requires_refresh(self):
        with tempfile.TemporaryDirectory(prefix='ptcg-skill-corrupt-') as tmp:
            args = self.automatic_args(tmp)
            with patch.object(converter, 'fetch_bytes', side_effect=self.upstream):
                self.assertEqual(self.run_conversion(args), 0)
            cached = args.cache_dir / self.catalog['dataset']['commit'] / 'ptcg_chs_infos.json'
            cached.write_bytes(self.dataset_raw + b' ')
            args.work_dir = Path(tmp) / 'corrupt'
            with self.assertRaisesRegex(ValueError, '缓存散列'):
                self.run_conversion(args)
            self.assertFalse(args.work_dir.exists())

    def test_network_failure_does_not_write_a_partial_cache(self):
        with tempfile.TemporaryDirectory(prefix='ptcg-skill-network-') as tmp:
            args = self.automatic_args(tmp)
            with patch.object(converter, 'fetch_bytes', side_effect=[json.dumps({'sha': 'a' * 40}).encode(), OSError('下载失败')]):
                with self.assertRaisesRegex(OSError, '下载失败'):
                    self.run_conversion(args)
            self.assertFalse(args.cache_dir.exists())
            self.assertFalse(args.work_dir.exists())

    def test_api_rate_limit_uses_remote_head_without_cloning(self):
        commit = 'c' * 40
        with patch.object(converter, 'fetch_bytes', side_effect=HTTPError(converter.LATEST_COMMIT, 403, 'limit', {}, None)), \
                patch.object(converter.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=commit + '\tHEAD\n')) as git:
            self.assertEqual(converter.latest_commit(), commit)
        self.assertEqual(git.call_args.args[0], ['git', 'ls-remote', converter.REPOSITORY + '.git', 'HEAD'])

    def test_changed_english_reference_is_pending(self):
        with tempfile.TemporaryDirectory(prefix='ptcg-skill-english-') as tmp:
            args = self.automatic_args(tmp)
            with patch.object(converter, 'fetch_bytes', side_effect=self.upstream):
                self.assertEqual(self.run_conversion(args), 0)
            path = args.cache_dir / 'english' / self.catalog['englishReference']['commit'] / 'test.json'
            changed = json.loads(path.read_text())
            changed[0]['hp'] = '160'
            converter.write_json(path, changed)
            args.work_dir = Path(tmp) / 'changed-english'
            with patch.object(converter, 'fetch_bytes', side_effect=AssertionError('已缓存不得请求网络')):
                self.assertEqual(self.run_conversion(args), 2)
            self.assertFalse((args.work_dir / 'deck.json').exists())
            self.assertIn('英文参考记录', (args.work_dir / 'pending.json').read_text())

    def test_local_supplement_requires_matching_image_and_text_hash(self):
        with tempfile.TemporaryDirectory(prefix='ptcg-skill-supplement-') as tmp:
            args = self.automatic_args(tmp)
            catalog = deepcopy(self.catalog)
            value = '这是合成测试规则框。'
            entry = catalog['entries'][0]
            entry['requiredSupplements'] = {'rulesText': converter.digest(value.encode())}
            converter.write_json(args.catalog, catalog)
            with patch.object(converter, 'fetch_bytes', side_effect=self.upstream):
                self.assertEqual(self.run_conversion(args), 2)
            pending = json.loads((args.work_dir / 'pending.json').read_text())['pending'][0]
            self.assertTrue(Path(pending['cardImage']).is_file())
            self.assertEqual(pending['requiredSupplements'], entry['requiredSupplements'])
            path = Path(pending['supplementsFile'])
            patches = {'cards': {entry['source']['sha256']: {
                'imageSha256': entry['evidence']['imageSha256'], 'fields': {'rulesText': '错误补录'}}}}
            converter.write_json(path, patches)
            args.work_dir = Path(tmp) / 'wrong-patch'
            with patch.object(converter, 'fetch_bytes', side_effect=AssertionError('已缓存不得请求网络')):
                self.assertEqual(self.run_conversion(args), 2)
            patches['cards'][entry['source']['sha256']]['fields']['rulesText'] = value
            converter.write_json(path, patches)
            args.work_dir = Path(tmp) / 'reviewed-patch'
            with patch.object(converter, 'fetch_bytes', side_effect=AssertionError('已缓存不得请求网络')):
                self.assertEqual(self.run_conversion(args), 0)
            self.assertEqual(json.loads((args.work_dir / 'deck.json').read_text())['cards'][0]['card']['rulesText'], value)


if __name__ == '__main__':
    unittest.main()
