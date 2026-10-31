"""使用本地缓存或 GitHub 最新数据转换 PTCG Live 卡表；不连接应用、不调用模型。"""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import subprocess
import unicodedata
from urllib.parse import quote
from urllib.error import HTTPError
from urllib.request import Request, urlopen

SKILL = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG = SKILL / 'references/verified-mappings.json'
DEFAULT_CACHE = SKILL.parents[2] / 'data/import-cache/duanxr'
REPOSITORY = 'https://github.com/duanxr/PTCG-CHS-Datasets'
RAW_BASE = 'https://raw.githubusercontent.com/duanxr/PTCG-CHS-Datasets'
ENGLISH_RAW_BASE = 'https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data'
LATEST_COMMIT = 'https://api.github.com/repos/duanxr/PTCG-CHS-Datasets/commits/main'
ENERGY_NAMES = dict(zip(
    ['基本草能量', '基本火能量', '基本水能量', '基本雷能量', '基本超能量',
     '基本斗能量', '基本恶能量', '基本钢能量', '基本妖能量'],
    ['草', '火', '水', '雷', '超', '斗', '恶', '钢', '妖']))
EN_TYPES = dict(zip(
    ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness',
     'Metal', 'Fairy', 'Dragon', 'Colorless'],
    ['草', '火', '水', '雷', '超', '斗', '恶', '钢', '妖', '龙', '无色']))


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def fingerprint(value):
    return digest(json.dumps(value, ensure_ascii=False, sort_keys=True,
                             separators=(',', ':')).encode())


def normalize_name(value):
    value = unicodedata.normalize('NFKD', value.replace('’', "'").replace('‘', "'"))
    return ' '.join(''.join(c for c in value if not unicodedata.combining(c)).casefold().split())


def card_key(set_code, number):
    number = str(number).upper()
    return (set_code.upper(), str(int(number)) if number.isdigit() else number)


def parse_export(raw):
    entries, declared = [], None
    section = re.compile(r'^(?:pok[eé]mon|trainers?|energy|宝可梦|训练家|能量)\s*(?::\s*\d+|\(\s*\d+\s*\))?\s*$', re.I)
    total = re.compile(r'^(?:total\s+cards|卡牌总数|总张数|总计)\s*:\s*(\d+)\s*$', re.I)
    for line_number, original in enumerate(raw.lstrip('\ufeff').splitlines(), 1):
        line = original.strip()
        if not line or line.startswith('#') or section.fullmatch(line):
            continue
        if line.startswith('******') and line.endswith('******'):
            continue
        footer = total.fullmatch(line)
        if footer:
            if declared is not None and declared != int(footer[1]):
                raise ValueError('多处总张数声明不一致')
            declared = int(footer[1])
            continue
        match = re.fullmatch(r'(\d+)\s+(.+?)\s+([A-Za-z0-9]{2,12})\s+([A-Za-z0-9-]+)', line)
        if not match or int(match[1]) < 1:
            raise ValueError(f'第 {line_number} 行不是有效卡牌条目：{line}')
        entries.append({'line': line_number, 'count': int(match[1]), 'name': match[2],
                        'set': match[3].upper(), 'number': match[4]})
    if not entries:
        raise ValueError('没有读到卡牌条目；只有小程序 ID 不能还原卡表')
    actual = sum(entry['count'] for entry in entries)
    if declared is not None and declared != actual:
        raise ValueError(f'页尾声明 {declared} 张，实际条目合计 {actual} 张')
    return entries


def load_dataset(path):
    raw = path.read_bytes()
    data = json.loads(raw)
    rows = [card for collection in data['collections'] for card in collection['cards']]
    dictionaries = {name: {str(item['dictCode']): item['dictValue'] for item in items}
                    for name, items in data['dict'].items()}
    return digest(raw), rows, dictionaries


def fetch_bytes(url):
    request = Request(url, headers={'User-Agent': 'ptcg-live-to-json'})
    with urlopen(request, timeout=30) as response:
        return response.read()


def validate_commit(commit):
    if not isinstance(commit, str) or not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('数据集必须记录有效的 GitHub 提交 SHA')
    return commit


def latest_commit():
    try:
        return validate_commit(json.loads(fetch_bytes(LATEST_COMMIT))['sha'])
    except HTTPError as error:
        if error.code not in (403, 429):
            raise
    # 公共 REST API 可能被共享出口限流；仅查询 HEAD，不克隆仓库或下载代码。
    result = subprocess.run(['git', 'ls-remote', f'{REPOSITORY}.git', 'HEAD'],
                            capture_output=True, text=True, timeout=30,
                            env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
    if result.returncode or not result.stdout.strip():
        raise OSError('GitHub API 限流，git ls-remote 也未取得最新提交；请稍后重试')
    return validate_commit(result.stdout.split()[0])


def resolve_dataset(args, catalog):
    """缓存缺失时获取 main 最新提交；每次转换固定到实际提交并记录散列。"""
    if args.dataset is not None:
        dataset_sha, _, _ = load_dataset(args.dataset)
        commit = args.dataset_commit
        if not commit:
            metadata = args.dataset.with_name('source.json')
            source = json.loads(metadata.read_text()) if metadata.is_file() else catalog['dataset']
            if source['sha256'] != dataset_sha:
                raise ValueError('本地数据散列没有对应来源；请提供 --dataset-commit 或使用自动缓存')
            commit = source['commit']
        return args.dataset, {'repository': REPOSITORY, 'commit': validate_commit(commit), 'sha256': dataset_sha}
    if args.dataset_commit:
        raise ValueError('--dataset-commit 只能与 --dataset 一起使用；刷新缓存使用 --refresh')
    latest = args.cache_dir / 'latest.json'
    if latest.is_file() and not args.refresh:
        source = json.loads(latest.read_text())
        commit = validate_commit(source['commit'])
        dataset = args.cache_dir / commit / 'ptcg_chs_infos.json'
        if dataset.is_file():
            dataset_sha, _, _ = load_dataset(dataset)
            if dataset_sha != source['sha256']:
                raise ValueError('本地缓存散列不符；使用 --refresh 重新下载')
            return dataset, {**source, 'repository': REPOSITORY}
    commit = latest_commit()
    raw = fetch_bytes(f'{RAW_BASE}/{commit}/ptcg_chs_infos.json')
    data = json.loads(raw)
    if not isinstance(data.get('collections'), list) or not isinstance(data.get('dict'), dict):
        raise ValueError('GitHub 数据格式无效；未保存缓存')
    directory = args.cache_dir / commit
    directory.mkdir(parents=True, exist_ok=True)
    dataset = directory / 'ptcg_chs_infos.json'
    temporary = dataset.with_suffix('.download')
    temporary.write_bytes(raw)
    temporary.replace(dataset)
    source = {'repository': REPOSITORY, 'commit': commit, 'sha256': digest(raw)}
    write_json(directory / 'source.json', source)
    write_json(latest, source)
    return dataset, source


def cache_card_image(entry, commit, cache_dir):
    """只获取本次用到的卡图；缓存和下载结果都核对既有核验散列。"""
    image = PurePosixPath(entry['source']['image'])
    if image.is_absolute() or '..' in image.parts or not image.parts:
        raise ValueError('卡图路径无效')
    path = cache_dir / commit / image
    raw = path.read_bytes() if path.is_file() else fetch_bytes(f'{RAW_BASE}/{commit}/{quote(image.as_posix())}')
    if digest(raw) != entry['evidence'].get('imageSha256'):
        raise ValueError('卡图散列与已核验映射不符；需重新查看原卡图并核验补录')
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    return {'url': f'{RAW_BASE}/{commit}/{quote(image.as_posix())}', 'sha256': digest(raw)}


def load_reference(entry, catalog, cache_dir):
    """仓库只保存英文身份与指纹；原始字段从固定上游提交获取并缓存。"""
    expected = entry['reference']
    identity = expected['id']
    if not re.fullmatch(r'[A-Za-z0-9]+-[A-Za-z0-9-]+', identity):
        raise ValueError('英文参考 ID 无效')
    commit = validate_commit(catalog['englishReference']['commit'])
    set_id = identity.rsplit('-', 1)[0]
    path = cache_dir / 'english' / commit / f'{set_id}.json'
    raw = path.read_bytes() if path.is_file() else fetch_bytes(f'{ENGLISH_RAW_BASE}/{commit}/cards/en/{set_id}.json')
    rows = json.loads(raw)
    if not isinstance(rows, list):
        raise ValueError('英文参考数据格式无效')
    matches = [row for row in rows if row.get('id') == identity]
    if len(matches) != 1 or fingerprint(matches[0]) != expected['sha256']:
        raise ValueError('英文参考记录缺失、不唯一或已变更；需重新核验编号与字段')
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    return matches[0]


def load_supplements(entry, commit, cache_dir):
    """卡面原文补录只留在被忽略的缓存；缺失时交由技能核对原图。"""
    fields = dict(entry.get('supplements', {}))
    required = entry.get('requiredSupplements', {})
    if not required:
        return fields
    path = cache_dir / commit / 'supplements.json'
    saved = json.loads(path.read_text()) if path.is_file() else {}
    card = saved.get('cards', {}).get(entry['source']['sha256'], {})
    if card.get('imageSha256') != entry['evidence']['imageSha256']:
        raise ValueError('缺少与原卡图一致的本地补录；查看缓存卡图并写入 supplements.json')
    for name, expected in required.items():
        value = card.get('fields', {}).get(name)
        if name not in {'rulesText', 'prependRulesText'} or not isinstance(value, str) or digest(value.encode()) != expected:
            raise ValueError(f'本地补录 {name} 缺失或散列不符；需核对原卡图')
        fields[name] = value
    return fields


def text(value):
    return '' if value is None or str(value).strip().lower() == 'none' else str(value).replace('|', '\n\n')


def select_source(rows, entry):
    source = entry['source']
    matches = [row for row in rows if
               (row['name'], row['commodityCode'], row['details']['collectionNumber'],
                row['id'], row['image']) ==
               (source['name'], source['set'], source['number'], source['id'], source['image'])]
    matches = {fingerprint(row): row for row in matches}
    if len(matches) != 1 or source['sha256'] not in matches:
        raise ValueError('简中印刷记录缺失、不唯一或已变更；需重新核对卡图与字段')
    if entry.get('reviewed') is not True or not entry.get('evidence'):
        raise ValueError('映射没有核验记录')
    return matches[source['sha256']]


def convert_card(record, entry, dictionaries, commit):
    d = record['details']
    patch = entry.get('supplements', {})
    card = {'name': record['name'], 'imageUrl':
            f'https://raw.githubusercontent.com/duanxr/PTCG-CHS-Datasets/{commit}/{record["image"]}'}
    tags = []
    for source_field, dictionary in [('pokemonType', 'pokemon_type'), ('specialCard', 'special_card')]:
        if d.get(source_field):
            tags.extend(dictionaries[dictionary][code] for code in str(d[source_field]).split(','))
    if tags:
        card['tags'] = tags
    if d['cardType'] == '1':
        card.update(kind='pokemon', hp=d['hp'],
                    types=[dictionaries['attribute'][code] for code in str(d['attribute']).split(',')],
                    stage=d['evolveText'],
                    abilities=[{'name': a['featureName'], 'text': text(a['featureDesc'])}
                               for a in d.get('cardFeatureItemList', [])],
                    attacks=[], weaknesses=[], resistances=[], retreatCost=d['retreatCost'])
        for attack in d['abilityItemList']:
            cost = text(attack.get('abilityCost'))
            costs = Counter(cost.split(',')) if cost else Counter()
            if '12' in costs:
                raise ValueError('招式含动态费用代码 +；需核对原卡并完善表示，不能作为能量类型输出')
            card['attacks'].append({
                'name': attack['abilityName'],
                'energyCost': [{'type': dictionaries['ability_cost'][code], 'count': count}
                               for code, count in costs.items()],
                'damageText': text(attack.get('abilityDamage')),
                'text': text(attack.get('abilityText')),
            })
        for target, kind, formula, dictionary in [
            ('weaknesses', 'weaknessType', 'weaknessFormula', 'weakness_type'),
            ('resistances', 'resistanceType', 'resistanceFormula', 'resistance_type'),
        ]:
            if d.get(kind):
                card[target] = [{'type': dictionaries[dictionary][str(d[kind])], 'modifier': d[formula]}]
        if patch.get('evolvesFrom'):
            card['evolvesFrom'] = patch['evolvesFrom']
        if card['stage'] != '基础' and not card.get('evolvesFrom'):
            raise ValueError('缺少经简中卡图核验的进化来源')
        rules = text(d.get('ruleText'))
        if patch.get('prependRulesText'):
            rules = patch['prependRulesText'] + ('\n\n' + rules if rules else '')
        if rules:
            card['rulesText'] = rules
    elif d['cardType'] == '2':
        subtype = {'物品': 'item', '宝可梦道具': 'tool', '支援者': 'supporter', '竞技场': 'stadium'}[d['trainerTypeText']]
        card.update(kind='trainer', subtype=subtype, text=text(d['ruleText']))
    elif d['cardType'] == '3':
        if d['energyTypeText'] == '基本能量':
            energy = entry['source'].get('energyType') or ENERGY_NAMES.get(card['name'])
            if not energy:
                raise ValueError('无法确定基本能量属性；需从卡图核验并记录 source.energyType')
            card.update(kind='energy', subtype='basic', energyType=energy)
            if text(d.get('ruleText')):
                card['text'] = text(d['ruleText'])
        elif d['energyTypeText'] == '特殊能量':
            card.update(kind='energy', subtype='special', text=text(d['ruleText']))
        else:
            raise ValueError('未知能量类别')
    else:
        raise ValueError('未知卡牌类别')
    if patch.get('rulesText'):
        card['rulesText'] = patch['rulesText']
    if ('ACE SPEC' in tags or '太晶' in tags) and not card.get('rulesText'):
        raise ValueError('缺少特殊规则框，需核对原卡')
    return card


def check_reference(card, entry, cn_names, reference_sets):
    """只交叉核对身份和结构数值；不将英文说明文写入简中输出。"""
    reference = entry['reference']
    set_id = reference['id'].rsplit('-', 1)[0]
    matching_sets = [item['id'] for item in reference_sets if item['ptcgoCode'] == entry['input']['set']]
    if set_id not in matching_sets or card_key(entry['input']['set'], reference['number']) != card_key(entry['input']['set'], entry['input']['number']):
        raise ValueError('英文参考与映射声明的系列编号不符')
    expected_kind = {'Pokémon': 'pokemon', 'Trainer': 'trainer', 'Energy': 'energy'}[reference['supertype']]
    if card['kind'] != expected_kind:
        raise ValueError('卡牌类别与输入编号不符')
    if card['kind'] != 'pokemon':
        if card['kind'] == 'trainer':
            subtype = next(value for key, value in [('Item', 'item'), ('Pokémon Tool', 'tool'),
                            ('Supporter', 'supporter'), ('Stadium', 'stadium')]
                           if key in reference['subtypes'])
            if card['subtype'] != subtype or not card['text']:
                raise ValueError('训练家类别不符或说明文缺失')
        elif card['subtype'] != ('basic' if 'Basic' in reference['subtypes'] else 'special'):
            raise ValueError('能量类别与输入编号不符')
        elif card['subtype'] == 'special' and not card['text']:
            raise ValueError('特殊能量说明文缺失')
        return
    stage = '基础' if 'Basic' in reference['subtypes'] else '1阶进化' if 'Stage 1' in reference['subtypes'] else '2阶进化' if 'Stage 2' in reference['subtypes'] else None
    checks = [(card['hp'], int(reference['hp'])), (card['stage'], stage),
              (card['types'], [EN_TYPES[value] for value in reference['types']]),
              (card['retreatCost'], len(reference.get('retreatCost', []))),
              (len(card['attacks']), len(reference.get('attacks', []))),
              (len(card['abilities']), len(reference.get('abilities', [])))]
    if reference.get('evolvesFrom') in cn_names:
        checks.append((card.get('evolvesFrom'), cn_names[reference['evolvesFrom']]))
    for field in ['weaknesses', 'resistances']:
        checks.append((card[field], [{'type': EN_TYPES[m['type']], 'modifier': m['value']}
                                    for m in reference.get(field, [])]))
    for attack, original in zip(card['attacks'], reference.get('attacks', [])):
        expected = Counter(EN_TYPES[cost] for cost in original['cost'] if cost != 'Free')
        checks.extend([(attack['damageText'], original['damage']),
                       ({cost['type']: cost['count'] for cost in attack['energyCost']}, dict(expected))])
        if original.get('text') and not attack['text']:
            raise ValueError('输入卡牌有招式说明，但简中记录为空')
    if any(left != right for left, right in checks):
        raise ValueError('基础字段与指定英文编号不符；不能用同名卡代替')


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def convert(args):
    raw = args.input.read_text(encoding='utf-8-sig')
    inputs = parse_export(raw)
    total = sum(entry['count'] for entry in inputs)
    if total != args.expected_total:
        raise ValueError(f'期望 {args.expected_total} 张，输入合计 {total} 张；不自动补牌或删牌')
    catalog = json.loads(args.catalog.read_text())
    dataset, source = resolve_dataset(args, catalog)
    _, rows, dictionaries = load_dataset(dataset)
    commit = source['commit']
    index = {}
    for entry in catalog['entries']:
        key = card_key(entry['input']['set'], entry['input']['number'])
        if key in index:
            raise ValueError(f'映射目录编号重复：{key}')
        index[key] = entry
    cn_names = {entry['input']['name']: entry['source']['name'] for entry in catalog['entries']}
    output, selected, pending = [], [], []
    for row in inputs:
        entry = index.get(card_key(row['set'], row['number']))
        try:
            if not entry:
                raise ValueError('没有已核验映射；查找对应简中卡面后补充独立映射目录')
            aliases = [entry['input']['name'], *entry['input'].get('aliases', [])]
            if normalize_name(row['name']) not in {normalize_name(name) for name in aliases}:
                raise ValueError('输入名称与该系列编号的已核验身份不符')
            record = select_source(rows, entry)
            reference = load_reference(entry, catalog, args.cache_dir)
            image = cache_card_image(entry, commit, args.cache_dir)
            resolved = {**entry, 'reference': reference, 'supplements': load_supplements(entry, commit, args.cache_dir)}
            card = convert_card(record, resolved, dictionaries, commit)
            check_reference(card, resolved, cn_names, catalog['englishReference']['sets'])
            output.append({'count': row['count'], 'card': card})
            selected.append({'input': row, 'mapping': entry, 'record': record, 'reference': reference,
                             'supplements': resolved['supplements'], 'image': image})
        except (ValueError, KeyError, TypeError, StopIteration, OSError) as error:
            pending.append({'input': row, 'reason': str(error), **({
                'requiredSupplements': entry.get('requiredSupplements', {}),
                'sourceSha256': entry['source']['sha256'],
                'imageSha256': entry['evidence']['imageSha256'],
                'cardImage': str(args.cache_dir / commit / entry['source']['image']),
                'supplementsFile': str(args.cache_dir / commit / 'supplements.json'),
            } if entry else {})})
    args.work_dir.mkdir(parents=True, exist_ok=False)
    (args.work_dir / 'source.txt').write_text(raw, encoding='utf-8')
    provenance = {'inputSha256': digest(raw.encode()), 'dataset': source, 'englishReference': catalog['englishReference'],
                  'catalogSha256': digest(args.catalog.read_bytes()),
                  'entries': len(inputs), 'totalCards': total}
    if pending:
        write_json(args.work_dir / 'pending.json', {**provenance, 'pending': pending})
        print(json.dumps({'status': 'pending', 'unresolved': len(pending),
                          'report': str(args.work_dir / 'pending.json')}, ensure_ascii=False))
        return 2
    deck = {'name': args.name, 'cards': output}
    write_json(args.work_dir / 'deck.json', deck)
    write_json(args.work_dir / 'selected-source-records.json', {'dict': dictionaries, 'cards': selected})
    summary = {**provenance, 'name': args.name,
               'outputSha256': digest((args.work_dir / 'deck.json').read_bytes()),
               'categories': {kind: sum(entry['count'] for entry in output if entry['card']['kind'] == kind)
                              for kind in ['pokemon', 'trainer', 'energy']},
               'basicPokemon': sum(entry['count'] for entry in output
                                   if entry['card']['kind'] == 'pokemon' and entry['card']['stage'] == '基础'),
               'mapping': [{'input': selection['input'], 'source': selection['mapping']['source'],
                            'supplements': selection['supplements'],
                            'evidence': {**selection['mapping']['evidence'], 'record': f'{RAW_BASE}/{commit}/ptcg_chs_infos.json',
                                         'image': selection['image']['url'], 'imageSha256': selection['image']['sha256']}}
                           for selection in selected]}
    write_json(args.work_dir / 'conversion.json', summary)
    print(json.dumps({'status': 'converted', 'output': str(args.work_dir / 'deck.json'),
                      'entries': len(output), 'totalCards': total, 'categories': summary['categories']}, ensure_ascii=False))
    return 0


def search(args):
    catalog = json.loads(DEFAULT_CATALOG.read_text())
    dataset, source = resolve_dataset(args, catalog)
    _, rows, _ = load_dataset(dataset)
    seen, results = set(), []
    for row in rows:
        if args.name not in row['name']:
            continue
        key = fingerprint(row)
        if key in seen:
            continue
        seen.add(key)
        d = row['details']
        results.append({'name': row['name'], 'set': row['commodityCode'],
                        'number': d['collectionNumber'], 'id': row['id'], 'image': row['image'],
                        'sha256': key, 'details': {key: d[key] for key in [
                            'hp', 'attribute', 'evolveText', 'cardFeatureItemList', 'abilityItemList',
                            'ruleText', 'weaknessType', 'weaknessFormula', 'resistanceType',
                            'resistanceFormula', 'retreatCost', 'trainerTypeText', 'energyTypeText'] if key in d}})
    print(json.dumps({'dataset': source, 'matches': len(results), 'shown': results[:args.limit]}, ensure_ascii=False, indent=2))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    source = argparse.ArgumentParser(add_help=False)
    source.add_argument('--dataset', type=Path, help='已有数据文件；省略时自动复用缓存或下载最新数据')
    source.add_argument('--dataset-commit', help='手工指定数据文件时对应的 GitHub 提交 SHA')
    source.add_argument('--cache-dir', type=Path, default=DEFAULT_CACHE, help='本地数据与卡图缓存目录')
    source.add_argument('--refresh', action='store_true', help='从 GitHub 获取最新数据并更新缓存')
    task = commands.add_parser('convert', parents=[source], help='转换已核验卡表；未覆盖的卡牌生成 pending.json，退出码 2')
    task.add_argument('--input', type=Path, required=True)
    task.add_argument('--work-dir', type=Path, required=True, help='新的本次转换目录，不覆盖旧记录')
    task.add_argument('--name', required=True)
    task.add_argument('--catalog', type=Path, default=DEFAULT_CATALOG)
    task.add_argument('--expected-total', type=int, default=60)
    task.set_defaults(run=convert)
    task = commands.add_parser('search', parents=[source], help='按简中名称在数据集中查候选，供原卡图核验')
    task.add_argument('--name', required=True)
    task.add_argument('--limit', type=int, default=10)
    task.set_defaults(run=search)
    args = parser.parse_args()
    try:
        return args.run(args)
    except (ValueError, KeyError, TypeError, OSError, subprocess.TimeoutExpired) as error:
        print(json.dumps({'status': 'error', 'message': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
