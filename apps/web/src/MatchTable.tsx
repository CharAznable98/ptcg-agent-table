import type {
  MatchView,
  ObjectView,
  Position,
  Viewer,
} from "../../../packages/protocol/src/index.ts";
import { Zone } from "./Cards.tsx";

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
}) {
  const bottom = viewer === "B" ? "B" : "A";
  const top = bottom === "A" ? "B" : "A";
  const zoneProps = {
    selected,
    highlighted,
    interactive,
    onSelect,
    onInspect,
    onPreview,
    onDestination,
  };
  return (
    <div className="playmat" aria-label="对战牌桌">
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
              const zone = view.zones.find(
                (zone) => zone.playerId === seat && zone.kind === kind,
              );
              return zone ? (
                <Zone key={zone.id} zone={zone} {...zoneProps} />
              ) : null;
            })}
          </div>
        </section>
      ))}
      {view.zones
        .filter((zone) => zone.kind === "stadium")
        .map((zone) => (
          <div className="stadium-shared" key={zone.id}>
            <Zone zone={zone} {...zoneProps} />
          </div>
        ))}
    </div>
  );
}
