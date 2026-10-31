import { useEffect, useState } from "react";
import type { PromptConfig } from "../../../packages/protocol/src/index.ts";
import type { ModelConfig } from "../../../packages/agent/src/config.ts";
import { api, jsonBody } from "./api.ts";
import { Button, Busy, ErrorNote, Field, JsonEditor } from "./ui.tsx";
const promptNames = {
  player: "对战玩家",
  judge: "独立裁判",
  summary: "赛后总结",
  compactor: "上下文压缩",
} as const;
export function Settings() {
  const [prompts, setPrompts] = useState<PromptConfig | null>(null);
  const [model, setModel] = useState<ModelConfig | null>(null);
  const [tab, setTab] = useState<
    "model" | keyof typeof promptNames | "tools" | "feedback"
  >("model");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [testing, setTesting] = useState(false);
  const [recordJson, setRecordJson] = useState("");
  useEffect(() => {
    void Promise.all([
      api<PromptConfig>("/settings/prompts"),
      api<ModelConfig>("/settings/model"),
    ])
      .then(([p, m]) => {
        setPrompts(p);
        setModel(m);
      })
      .catch((error) => setError(error.message));
  }, []);
  if (!prompts || !model)
    return (
      <main className="page">
        <ErrorNote value={error} />
        <Busy text="读取系统配置…" />
      </main>
    );
  const setTabValue = (next: typeof tab) => {
    let draft = prompts;
    if (tab === "tools" || tab === "feedback") {
      try {
        const values: unknown = JSON.parse(recordJson);
        if (
          values === null ||
          Array.isArray(values) ||
          typeof values !== "object" ||
          Object.values(values).some((value) => typeof value !== "string")
        )
          throw new Error("工具说明和纠错反馈必须为字符串映射对象");
        draft = {
          ...prompts,
          [tab === "tools" ? "toolDescriptions" : "feedback"]: values,
        };
        setPrompts(draft);
      } catch (error) {
        setError(`当前 JSON 无效，请修正后切换：${(error as Error).message}`);
        return;
      }
    }
    setTab(next);
    if (next === "tools" || next === "feedback")
      setRecordJson(
        JSON.stringify(
          next === "tools" ? draft.toolDescriptions : draft.feedback,
          null,
          2,
        ),
      );
  };
  return (
    <main className="page settings-page">
      <div className="page-heading">
        <div>
          <h1>系统配置</h1>
          <p className="muted">配置仅对新对局生效。</p>
        </div>
      </div>
      <div className="settings-layout">
        <aside className="settings-nav">
          <button
            className={tab === "model" ? "active" : ""}
            onClick={() => setTabValue("model")}
          >
            模型连接 <span>↗</span>
          </button>
          {Object.entries(promptNames).map(([key, name]) => (
            <button
              className={tab === key ? "active" : ""}
              key={key}
              onClick={() => setTabValue(key as keyof typeof promptNames)}
            >
              {name}提示词
            </button>
          ))}
          <button
            className={tab === "tools" ? "active" : ""}
            onClick={() => setTabValue("tools")}
          >
            工具说明
          </button>
          <button
            className={tab === "feedback" ? "active" : ""}
            onClick={() => setTabValue("feedback")}
          >
            纠错反馈
          </button>
        </aside>
        <section className="settings-content">
          <ErrorNote value={error} />
          {message && (
            <p className="success" role="status">
              {message}
            </p>
          )}
          {tab === "model" ? (
            <>
              <h2>模型连接</h2>
              <Field label="连接方式">
                <select
                  value={model.connection.kind}
                  onChange={(event) =>
                    setModel({
                      ...model,
                      connection:
                        event.target.value === "local_codex_credentials"
                          ? { kind: "local_codex_credentials" }
                          : {
                              kind: "openai_compatible",
                              baseUrl: "https://api.openai.com/v1",
                              apiKeyEnv: "OPENAI_API_KEY",
                              protocol: "responses",
                            },
                    })
                  }
                >
                  <option value="local_codex_credentials">
                    本地 ChatGPT / Codex 凭证
                  </option>
                  <option value="openai_compatible">OpenAI 兼容接口</option>
                </select>
              </Field>
              {model.connection.kind === "local_codex_credentials" ? (
                <>
                  <Field label="凭证文件（留空使用默认位置）">
                    <input
                      value={model.connection.authFile ?? ""}
                      onChange={(event) => {
                        if (model.connection.kind !== "local_codex_credentials")
                          return;
                        const connection = { ...model.connection };
                        if (event.target.value)
                          connection.authFile = event.target.value;
                        else delete connection.authFile;
                        setModel({ ...model, connection });
                      }}
                    />
                  </Field>
                  <Field label="请求地址（可选）">
                    <input
                      placeholder="使用默认 Codex 模型请求地址"
                      value={model.connection.baseUrl ?? ""}
                      onChange={(event) => {
                        const connection = { ...model.connection };
                        if (event.target.value)
                          connection.baseUrl = event.target.value;
                        else delete connection.baseUrl;
                        setModel({ ...model, connection });
                      }}
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="接口地址">
                    <input
                      value={model.connection.baseUrl}
                      onChange={(event) => {
                        if (model.connection.kind === "openai_compatible")
                          setModel({
                            ...model,
                            connection: {
                              ...model.connection,
                              baseUrl: event.target.value,
                            },
                          });
                      }}
                    />
                  </Field>
                  <Field
                    label="API Key 环境变量名称"
                    hint="在服务端配置该环境变量。网页不读取或保存密钥正文。"
                  >
                    <input
                      value={model.connection.apiKeyEnv}
                      onChange={(event) => {
                        if (model.connection.kind === "openai_compatible")
                          setModel({
                            ...model,
                            connection: {
                              ...model.connection,
                              apiKeyEnv: event.target.value,
                            },
                          });
                      }}
                    />
                  </Field>
                  <Field label="接口协议">
                    <select
                      value={model.connection.protocol}
                      onChange={(event) => {
                        if (model.connection.kind === "openai_compatible")
                          setModel({
                            ...model,
                            connection: {
                              ...model.connection,
                              protocol: event.target.value as
                                | "responses"
                                | "chat_completions",
                            },
                          });
                      }}
                    >
                      <option value="responses">Responses</option>
                      <option value="chat_completions">Chat Completions</option>
                    </select>
                  </Field>
                </>
              )}
              <div className="form-grid">
                <Field label="模型">
                  <input
                    value={model.model}
                    onChange={(event) =>
                      setModel({ ...model, model: event.target.value })
                    }
                  />
                </Field>
                <Field label="思考强度">
                  <input value="medium" readOnly />
                </Field>
                <Field label="超时（毫秒）">
                  <input
                    type="number"
                    min="1000"
                    max="600000"
                    value={model.timeoutMs ?? 120000}
                    onChange={(event) =>
                      setModel({
                        ...model,
                        timeoutMs: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="最大重试">
                  <input
                    type="number"
                    min="0"
                    max="4"
                    value={model.maxRetries ?? 2}
                    onChange={(event) =>
                      setModel({
                        ...model,
                        maxRetries: Number(event.target.value),
                      })
                    }
                  />
                </Field>
              </div>
              <div className="actions">
                <Button
                  kind="primary"
                  onClick={() => {
                    setError("");
                    void api<ModelConfig>("/settings/model", {
                      method: "PUT",
                      body: jsonBody(model),
                    })
                      .then((value) => {
                        setModel(value);
                        setMessage("模型配置已保存");
                      })
                      .catch((error) => setError(error.message));
                  }}
                >
                  保存模型配置
                </Button>
                <Button
                  disabled={testing}
                  onClick={() => {
                    setTesting(true);
                    setError("");
                    void api<{
                      ok: boolean;
                      model?: string;
                      elapsedMs?: number;
                      error?: string;
                    }>("/settings/model/test", { method: "POST" })
                      .then((result) => {
                        if (!result.ok)
                          throw new Error(result.error || "连接失败");
                        setMessage(
                          `连接成功 · ${result.model ?? model.model} · ${result.elapsedMs ?? 0} ms`,
                        );
                      })
                      .catch((error) => setError(error.message))
                      .finally(() => setTesting(false));
                  }}
                >
                  {testing ? "测试中…" : "测试连接"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <h2>
                {tab === "tools"
                  ? "工具说明"
                  : tab === "feedback"
                    ? "纠错反馈"
                    : `${promptNames[tab]}提示词`}
              </h2>
              <p className="muted">
                {tab === "player"
                  ? "用于每次对战决策。"
                  : tab === "judge"
                    ? "用于异议辩护后的裁判。"
                    : tab === "summary"
                      ? "用于终局后的策略总结。"
                      : tab === "compactor"
                        ? "用于局内上下文压缩。"
                        : "用于模型工具调用与错误反馈。"}
              </p>
              {tab === "tools" || tab === "feedback" ? (
                <JsonEditor
                  value={recordJson}
                  onChange={setRecordJson}
                  rows={24}
                />
              ) : (
                <Field label="提示词正文">
                  <textarea
                    className="prompt-text"
                    rows={26}
                    value={prompts[tab]}
                    onChange={(event) =>
                      setPrompts({ ...prompts, [tab]: event.target.value })
                    }
                  />
                </Field>
              )}
              <div className="actions">
                <Button
                  kind="primary"
                  onClick={() => {
                    try {
                      const next =
                        tab === "tools"
                          ? {
                              ...prompts,
                              toolDescriptions: JSON.parse(recordJson),
                            }
                          : tab === "feedback"
                            ? { ...prompts, feedback: JSON.parse(recordJson) }
                            : prompts;
                      setError("");
                      void api<PromptConfig>("/settings/prompts", {
                        method: "PUT",
                        body: jsonBody(next),
                      })
                        .then((value) => {
                          setPrompts(value);
                          setMessage("已保存，下局生效");
                        })
                        .catch((error) => setError(error.message));
                    } catch {
                      setError("JSON 格式无效");
                    }
                  }}
                >
                  保存提示词配置
                </Button>
                <Button
                  onClick={() => {
                    setError("");
                    void api<PromptConfig>("/settings/prompts/default")
                      .then((value) => {
                        setPrompts(value);
                        if (tab === "tools" || tab === "feedback")
                          setRecordJson(
                            JSON.stringify(
                              tab === "tools"
                                ? value.toolDescriptions
                                : value.feedback,
                              null,
                              2,
                            ),
                          );
                        setMessage(
                          "已载入默认配置，尚未保存",
                        );
                      })
                      .catch((error) => setError(error.message));
                  }}
                >
                  载入默认配置
                </Button>
                <Button
                  onClick={() => {
                    setError("");
                    void api<PromptConfig>("/settings/prompts")
                      .then((value) => {
                        setPrompts(value);
                        if (tab === "tools" || tab === "feedback")
                          setRecordJson(
                            JSON.stringify(
                              tab === "tools"
                                ? value.toolDescriptions
                                : value.feedback,
                              null,
                              2,
                            ),
                          );
                        setMessage("已重新读取保存的配置");
                      })
                      .catch((error) => setError(error.message));
                  }}
                >
                  放弃未保存修改
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
