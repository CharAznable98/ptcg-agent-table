import { useEffect, useState } from "react";
import { Home } from "./Home.tsx";
import { Library } from "./Library.tsx";
import { Settings } from "./Settings.tsx";
import { Match } from "./Match.tsx";
export function App() {
  const [route, setRoute] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const listener = () => setRoute(location.hash.slice(1) || "/");
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  const go = (path: string) => {
    location.hash = path;
    setRoute(path);
  };
  const matchId = route.startsWith("/match/")
    ? decodeURIComponent(route.slice(7))
    : null;
  return (
    <div className={`app-frame ${matchId ? "app-frame-match" : ""}`}>
      {!matchId && (
        <header className="app-header">
          <button
            className="brand"
            onClick={() => go("/")}
            aria-label="PTCG 首页"
          >
            <span>PTCG</span>
          </button>
          <nav aria-label="主导航">
            <button
              className={route === "/" || matchId ? "active" : ""}
              onClick={() => go("/")}
            >
              对战
            </button>
            <button
              className={route === "/library" ? "active" : ""}
              onClick={() => go("/library")}
            >
              资料库
            </button>
            <button
              className={route === "/settings" ? "active" : ""}
              onClick={() => go("/settings")}
            >
              系统配置
            </button>
          </nav>
        </header>
      )}
      {matchId ? (
        <Match key={matchId} id={matchId} back={() => go("/")} />
      ) : route === "/library" ? (
        <Library />
      ) : route === "/settings" ? (
        <Settings />
      ) : (
        <Home openMatch={(id) => go(`/match/${encodeURIComponent(id)}`)} />
      )}
    </div>
  );
}
