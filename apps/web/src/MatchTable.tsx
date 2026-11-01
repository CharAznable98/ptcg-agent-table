import type {
  MatchView,
  GameCommand,
  HumanActionIntent,
  ObjectView,
  Position,
  Viewer,
} from "../../../packages/protocol/src/index.ts";
import { Zone } from "./Cards.tsx";
import { DirectTableContext, projectSetupPlacement, useDirectManipulation, type SetupPlacement } from "./direct-manipulation.tsx";
import { objectAt, positionKey } from "./table-utils.ts";
import "./human-actions.css";

export function MatchTable({
  view,
  viewer,
  selected,
  highlighted,
  interactive,
  onSelect,
  onInspect,
  onPreview,
  onDestination,
  onIntent,
  humanActionBusy = false,
  manualMode = false,
  onManualMove,
  onManualState,
  setupPlacement,
  onSetupPlacement,
  inert = false,
}: {
  view: MatchView;
  viewer: Viewer;
  selected: Position[];
  highlighted: Position[];
  interactive: boolean;
  onSelect: (position: Position) => void;
  onInspect: (object: ObjectView) => void;
  onPreview: (object: ObjectView | null) => void;
  onDestination: (key: string, index: number) => void;
  onIntent?: (intent: HumanActionIntent) => void;
  humanActionBusy?: boolean;
  manualMode?: boolean;
  onManualMove?: (source: Position, target: Position) => void;
  onManualState?: (target: Position, field: Extract<GameCommand, { kind: "set_state" }>["field"]) => void;
  setupPlacement?: SetupPlacement;
  onSetupPlacement?: (placement: SetupPlacement) => void;
  inert?: boolean;
}) {
  const projection = projectSetupPlacement(view, viewer, setupPlacement);
  const displayView = projection.view;
  const direct = useDirectManipulation({ view, viewer, enabled: Boolean(interactive || setupPlacement) && !humanActionBusy, manual: manualMode, onIntent, onManualMove, onManualState, onPreview, setupPlacement, onSetupPlacement, ghosts: projection.ghosts });
  const originalObject = (object: ObjectView) => {
    const source = projection.ghosts.get(positionKey(object.position));
    return source ? objectAt(view, source) ?? object : object;
  };
  const bottom = viewer === "B" ? "B" : "A";
  const top = bottom === "A" ? "B" : "A";
  const zoneProps = {
    selected,
    highlighted,
    interactive: Boolean(interactive || setupPlacement),
    onSelect,
    onInspect: (object: ObjectView) => onInspect(originalObject(object)),
    onPreview: (object: ObjectView | null) => onPreview(object ? originalObject(object) : null),
    onDestination,
  };
  return (
    <DirectTableContext.Provider value={onIntent || setupPlacement ? direct.context : null}>
    <div className={`playmat ${onIntent || setupPlacement ? "direct-table" : ""} ${direct.context.dragging ? "is-dragging" : ""} ${manualMode ? "manual-table" : ""} ${setupPlacement ? "setup-table" : ""}`} aria-label="对战牌桌"
      inert={inert}
      ref={direct.tableRef} tabIndex={-1}
      aria-busy={humanActionBusy || undefined}
      onDragEnter={(event) => { if (direct.acceptsSurface()) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
      onDragOver={(event) => { if (direct.acceptsSurface()) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
      onDrop={(event) => { if (direct.acceptsSurface()) { event.preventDefault(); direct.context.drop(); } }}
      onKeyDown={(event) => { if (event.key === "Escape") direct.context.cancel(); }}>
      {direct.context.active && (direct.context.active.kind === "ability" || (() => {
        const zone = view.zones.find((zone) => zone.id === direct.context.active?.position.zoneId);
        const item = zone?.items[direct.context.active!.position.index];
        return item?.kind === "card" && item.card.kind === "trainer";
      })()) && <button type="button" className="direct-use-target" aria-label="放下并使用卡牌或特性"
        onClick={() => direct.context.drop()} onKeyDown={(event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); direct.context.drop(); } }}>
        放下使用
      </button>}
      {[top, bottom].map((seat, index) => (
        <section
          className={`player-half ${index === 0 ? "opponent-half" : "own-half"} ${view.flow.operator === seat && view.flow.phase !== "finished" ? "has-operation" : ""}`}
          key={seat}
          aria-label={`玩家 ${seat} 牌桌`}
        >
          <div className="seat-label">
            <b>{seat}</b>
            <span
              title={view.players.find((player) => player.id === seat)?.name}
            >
              {view.players.find((player) => player.id === seat)?.name}
            </span>
            {view.flow.operator === seat && view.flow.phase !== "finished" && (
              <small>操作中</small>
            )}
          </div>
          <div className="zones-grid">
            {(
              ["hand", "prizes", "deck", "discard", "active", "bench"] as const
            ).map((kind) => {
              const zone = displayView.zones.find(
                (zone) => zone.playerId === seat && zone.kind === kind,
              );
              return zone ? (
                <Zone key={zone.id} zone={zone} {...zoneProps} />
              ) : null;
            })}
          </div>
        </section>
      ))}
      {displayView.zones
        .filter((zone) => zone.kind === "stadium")
        .map((zone) => (
          <div className="stadium-shared" key={zone.id}>
            <Zone zone={zone} {...zoneProps} />
          </div>
        ))}
      <span className={`direct-table-notice ${direct.notice ? "has-notice" : ""}`} role="status" aria-live="polite">
        {direct.context.active ? "拖向目标 · Esc 取消" : direct.notice}
      </span>
    </div>
    </DirectTableContext.Provider>
  );
}
