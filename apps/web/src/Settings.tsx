import { useEffect, useRef, useState } from "react";
import type {
  ModelOption,
  ModelOptionsResponse,
  ModelSettings,
  ModelSettingsInput,
  ModelTestResult,
  PromptConfig,
  ReasoningEffort,
} from "../../../packages/protocol/src/index.ts";
import { api, jsonBody } from "./api.ts";
import { Button, Busy, ErrorNote, Field, JsonEditor } from "./ui.tsx";
const promptNames = {
  player: "对战玩家",
  judge: "独立裁判",
  summary: "赛后总结",
  compactor: "上下文压缩",
  humanExecutor: "人类操作代理",
} as const;
const effortNames: Record<ReasoningEffort, string> = {
  default: "接口默认",
  none: "不启用（none）",
  minimal: "最低（minimal）",
  low: "低（low）",
  medium: "中（medium）",
  high: "高（high）",
  xhigh: "更高（xhigh）",
  max: "最高（max）",
};
const effortName = (effort: ReasoningEffort) =>
  Object.hasOwn(effortNames, effort) ? effortNames[effort]! : effort;
function connectionKey(model: ModelSettings): string {
  return JSON.stringify([
    model.connection.kind,
    model.connection.baseUrl ?? "",
    model.connection.kind === "local_codex_credentials"
      ? (model.connection.authFile ?? "")
      : "",
  ]);
}
function modelInput(model: ModelSettings, apiKey: string): ModelSettingsInput {
  const { apiKeyConfigured: _configured, ...config } = model;
  return {
    ...config,
    ...(model.connection.kind === "openai_compatible" && apiKey.trim()
      ? { apiKey: apiKey.trim() }
      : {}),
  };
}
export function Settings() {
  const [prompts, setPrompts] = useState<PromptConfig | null>(null);
  const [model, setModel] = useState<ModelSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const savedConnection = useRef("");
  const revision = useRef(0);
  const listRequest = useRef(0);
  const [tab, setTab] = useState<
    "model" | keyof typeof promptNames | "tools" | "feedback"
  >("model");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [testing, setTesting] = useState(false);
  const [recordJson, setRecordJson] = useState("");
  const refreshModels = async (draft: ModelSettings, key: string) => {
    const request = ++listRequest.current;
    const currentRevision = ++revision.current;
    setTesting(false);
    setLoadingModels(true);
    setError("");
    setMessage("");
    try {
      const result = await api<ModelOptionsResponse>("/settings/model/models", {
        method: "POST",
        body: jsonBody(modelInput(draft, key)),
      });
      if (
        request !== listRequest.current ||
        currentRevision !== revision.current
      )
        return;
      if (!Array.isArray(result.models) || !result.models.length)
        throw new Error("接口未返回可用模型");
      setModelOptions(result.models);
      const selected =
        result.models.find((option) => option.id === draft.model) ??
        result.models[0]!;
      setModel({
        ...draft,
        model: selected.id,
      });
    } catch (error) {
      if (
        request === listRequest.current &&
        currentRevision === revision.current
      )
        setError((error as Error).message);
    } finally {
      if (request === listRequest.current) setLoadingModels(false);
    }
  };
  useEffect(() => {
    let active = true;
    void Promise.all([
      api<PromptConfig>("/settings/prompts"),
      api<ModelSettings>("/settings/model"),
    ])
      .then(([p, m]) => {
        if (!active) return;
        setPrompts(p);
        setModel(m);
        savedConnection.current = connectionKey(m);
        if (
          m.connection.kind === "local_codex_credentials" ||
          m.apiKeyConfigured
        )
          void refreshModels(m, "");
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
      listRequest.current++;
    };
  }, []);
  if (!prompts || !model)
    return (
      <main className="page">
        <ErrorNote value={error} />
        <Busy text="读取系统配置…" />
      </main>
    );
  const editModel = (next: ModelSettings, invalidateList = false) => {
    revision.current++;
    listRequest.current++;
    setLoadingModels(false);
    setTesting(false);
    setError("");
    setMessage("");
    if (invalidateList) setModelOptions([]);
    setModel(next);
  };
  const sameSavedConnection = connectionKey(model) === savedConnection.current;
  const selectedModel = modelOptions.find(
    (option) => option.id === model.model,
  );
  const canUseModel = Boolean(selectedModel || sameSavedConnection);
  const reportedEfforts = selectedModel?.reasoningEfforts;
  const availableEfforts = reportedEfforts?.filter(
    (effort) =>
      effort !== "default" &&
      (!selectedModel?.reasoningRequired || effort !== "none"),
  );
  const unsupportedEffort =
    model.reasoningEffort !== "default" &&
    ((availableEfforts !== undefined &&
      !availableEfforts.includes(model.reasoningEffort)) ||
      (selectedModel?.reasoningRequired === true &&
        model.reasoningEffort === "none"));
  const efforts = [
    ...new Set<ReasoningEffort>([
      "default",
      ...(availableEfforts ?? []),
      ...(model.reasoningEffort !== "default" ? [model.reasoningEffort] : []),
    ]),
  ];
  const defaultEffortName = selectedModel?.defaultReasoningEffort
    ? `接口默认 · ${effortName(selectedModel.defaultReasoningEffort)}`
    : "接口默认";
  const effortHint = unsupportedEffort
    ? `当前模型不支持 ${model.reasoningEffort}，请选择思考强度。`
    : reportedEfforts === undefined
      ? model.reasoningEffort === "default"
        ? "接口未提供思考档位。"
        : "接口未提供思考档位，当前值未确认。"
      : "";
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
              <fieldset
                className="model-settings-fields"
                disabled={savingModel}
              >
                <Field label="连接方式">
                  <select
                    value={model.connection.kind}
                    onChange={(event) => {
                      setApiKey("");
                      editModel(
                        {
                          ...model,
                          apiKeyConfigured: false,
                          connection:
                            event.target.value === "local_codex_credentials"
                              ? { kind: "local_codex_credentials" }
                              : {
                                  kind: "openai_compatible",
                                  baseUrl: "https://api.openai.com/v1",
                                  protocol: "responses",
                                },
                        },
                        true,
                      );
                    }}
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
                          if (
                            model.connection.kind !== "local_codex_credentials"
                          )
                            return;
                          const connection = { ...model.connection };
                          if (event.target.value)
                            connection.authFile = event.target.value;
                          else delete connection.authFile;
                          editModel({ ...model, connection }, true);
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
                          editModel({ ...model, connection }, true);
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
                          if (model.connection.kind !== "openai_compatible")
                            return;
                          const {
                            apiKeyFile: _file,
                            apiKeyEnv: _env,
                            ...connection
                          } = model.connection;
                          setApiKey("");
                          editModel(
                            {
                              ...model,
                              apiKeyConfigured: false,
                              connection: {
                                ...connection,
                                baseUrl: event.target.value,
                              },
                            },
                            true,
                          );
                        }}
                      />
                    </Field>
                    <Field
                      label="API Key"
                      hint={
                        model.apiKeyConfigured
                          ? "已保存，留空保留原密钥。"
                          : "保存到本机。"
                      }
                    >
                      <input
                        aria-label="API Key"
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={
                          model.apiKeyConfigured
                            ? "已保存 API Key"
                            : "填写 API Key"
                        }
                        value={apiKey}
                        onChange={(event) => {
                          setApiKey(event.target.value);
                          editModel(model, true);
                        }}
                      />
                    </Field>
                    <Field label="接口协议">
                      <select
                        value={model.connection.protocol}
                        onChange={(event) => {
                          if (model.connection.kind === "openai_compatible")
                            editModel({
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
                        <option value="chat_completions">
                          Chat Completions
                        </option>
                      </select>
                    </Field>
                  </>
                )}
                <div className="form-grid">
                  <Field label="模型">
                    <select
                      value={canUseModel ? model.model : ""}
                      onChange={(event) => {
                        editModel({
                          ...model,
                          model: event.target.value,
                        });
                      }}
                    >
                      {!canUseModel && (
                        <option value="" disabled>
                          请刷新模型后选择
                        </option>
                      )}
                      {!selectedModel && sameSavedConnection && (
                        <option value={model.model}>
                          {model.model}（当前配置）
                        </option>
                      )}
                      {modelOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.id}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="思考强度">
                    <select
                      aria-label="思考强度"
                      aria-describedby={
                        effortHint ? "reasoning-effort-hint" : undefined
                      }
                      aria-invalid={unsupportedEffort || undefined}
                      value={model.reasoningEffort}
                      onChange={(event) =>
                        editModel({
                          ...model,
                          reasoningEffort: event.target
                            .value as ReasoningEffort,
                        })
                      }
                    >
                      {efforts.map((effort) => (
                        <option
                          key={effort}
                          value={effort}
                          disabled={
                            unsupportedEffort &&
                            effort === model.reasoningEffort
                          }
                        >
                          {effort === "default"
                            ? defaultEffortName
                            : `${effortName(effort)}${unsupportedEffort && effort === model.reasoningEffort ? " · 不支持" : ""}`}
                        </option>
                      ))}
                    </select>
                    {effortHint && (
                      <small id="reasoning-effort-hint">{effortHint}</small>
                    )}
                  </Field>
                  <Field label="超时（毫秒）">
                    <input
                      type="number"
                      min="1000"
                      max="600000"
                      value={model.timeoutMs ?? 120000}
                      onChange={(event) =>
                        editModel({
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
                        editModel({
                          ...model,
                          maxRetries: Number(event.target.value),
                        })
                      }
                    />
                  </Field>
                </div>
                <div className="actions">
                  <Button
                    disabled={loadingModels}
                    onClick={() => void refreshModels(model, apiKey)}
                  >
                    {loadingModels ? "读取模型中…" : "刷新模型"}
                  </Button>
                  <Button
                    kind="primary"
                    disabled={
                      !canUseModel ||
                      unsupportedEffort ||
                      savingModel ||
                      loadingModels
                    }
                    onClick={() => {
                      setSavingModel(true);
                      setError("");
                      setMessage("");
                      revision.current++;
                      listRequest.current++;
                      setLoadingModels(false);
                      setTesting(false);
                      void api<ModelSettings>("/settings/model", {
                        method: "PUT",
                        body: jsonBody(modelInput(model, apiKey)),
                      })
                        .then((value) => {
                          setModel(value);
                          setApiKey("");
                          savedConnection.current = connectionKey(value);
                          setMessage("模型配置已保存");
                        })
                        .catch((error) => setError(error.message))
                        .finally(() => setSavingModel(false));
                    }}
                  >
                    {savingModel ? "保存中…" : "保存模型配置"}
                  </Button>
                  <Button
                    disabled={
                      testing ||
                      !canUseModel ||
                      unsupportedEffort ||
                      loadingModels
                    }
                    onClick={() => {
                      const currentRevision = revision.current;
                      setTesting(true);
                      setError("");
                      setMessage("");
                      void api<ModelTestResult>("/settings/model/test", {
                        method: "POST",
                        body: jsonBody(modelInput(model, apiKey)),
                      })
                        .then((result) => {
                          if (currentRevision !== revision.current) return;
                          if (!result.ok)
                            throw new Error(result.error || "连接失败");
                          setMessage(
                            `连接成功 · ${result.model ?? model.model} · ${result.elapsedMs} ms`,
                          );
                        })
                        .catch((error) => {
                          if (currentRevision === revision.current)
                            setError(error.message);
                        })
                        .finally(() => {
                          if (currentRevision === revision.current)
                            setTesting(false);
                        });
                    }}
                  >
                    {testing ? "测试中…" : "测试连接"}
                  </Button>
                </div>
              </fieldset>
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
                        : tab === "humanExecutor"
                          ? "执行人类操牌意图，所有游戏选择交由人完成。"
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
                    value={prompts[tab] ?? ""}
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
                        setMessage("已载入默认配置，尚未保存");
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
