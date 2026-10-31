import { useState } from "react";

export function CardBack({ label }: { label: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`card-back${failed ? "" : " has-image"}`}>
      {failed ? (
        <span>{label}</span>
      ) : (
        <img
          className="card-back-image"
          src="/api/assets/card-back.png"
          alt=""
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
