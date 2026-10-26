import { createContext, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { LockKey, ShieldCheck } from "@phosphor-icons/react";
import { api, clearCsrfToken, jsonBody, setCsrfToken } from "./api";
import { Button, InlineAlert, Spinner } from "./components/ui";

type AuthState = {
  ready: boolean;
  authenticated: boolean;
  pinConfigured: boolean;
  lock: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [pinConfigured, setPinConfigured] = useState(false);

  const check = async () => {
    try {
      const [bootstrap, session] = await Promise.all([
        api<{ pinConfigured: boolean }>("/api/bootstrap"),
        api<{ authenticated: boolean; csrf?: string }>("/api/auth/session")
      ]);
      setPinConfigured(Boolean(bootstrap.data?.pinConfigured));
      setAuthenticated(Boolean(session.data?.authenticated));
      if (session.data?.csrf) setCsrfToken(session.data.csrf);
    } finally {
      setReady(true);
    }
  };

  useEffect(() => {
    void check();
    const listener = () => { clearCsrfToken(); setAuthenticated(false); };
    window.addEventListener("jianzuo:locked", listener);
    return () => window.removeEventListener("jianzuo:locked", listener);
  }, []);

  const value = useMemo<AuthState>(() => ({
    ready,
    authenticated,
    pinConfigured,
    lock: async () => {
      await api("/api/auth/lock", { method: "POST" });
      clearCsrfToken();
      setAuthenticated(false);
    }
  }), [ready, authenticated, pinConfigured]);

  if (!ready) return <div className="splash"><Spinner size={28} /><span>正在启动本地工作台</span></div>;
  if (!authenticated) return <PinScreen configured={pinConfigured} onSuccess={(csrf) => { setCsrfToken(csrf); setAuthenticated(true); setPinConfigured(true); }} />;
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function PinScreen({ configured, onSuccess }: { configured: boolean; onSuccess: (csrf: string) => void }) {
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!/^\d{6,12}$/.test(pin)) return setError("PIN 需要 6–12 位数字");
    if (!configured && pin !== confirmPin) return setError("两次输入的 PIN 不一致");
    setBusy(true);
    try {
      const response = await api<{ csrf: string }>(configured ? "/api/auth/unlock" : "/api/auth/setup", { method: "POST", ...jsonBody({ pin }) });
      onSuccess(response.data!.csrf);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  return <main className="pin-page">
    <section className="pin-panel" aria-labelledby="pin-title">
      <div className="brand-mark large" aria-hidden="true"><span>简</span></div>
      <div>
        <p className="eyebrow">简作本地工作台</p>
        <h1 id="pin-title">{configured ? "解锁简作工作台" : "设置本地 PIN"}</h1>
        <p className="subtle">仅在这台电脑的 127.0.0.1 上运行。浏览器登录资料不会写入数据库或备份。</p>
      </div>
      <form onSubmit={submit} className="pin-form">
        <label><span>{configured ? "本地 PIN" : "新 PIN"}</span><div className="input-with-icon"><LockKey size={18} /><input autoFocus inputMode="numeric" autoComplete={configured ? "current-password" : "new-password"} type="password" value={pin} onChange={(event) => setPin(event.target.value)} placeholder="6–12 位数字" /></div></label>
        {!configured && <label><span>再次输入</span><div className="input-with-icon"><ShieldCheck size={18} /><input inputMode="numeric" autoComplete="new-password" type="password" value={confirmPin} onChange={(event) => setConfirmPin(event.target.value)} placeholder="再次输入 PIN" /></div></label>}
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
        <Button type="submit" size="large" loading={busy}>{configured ? "解锁工作台" : "完成设置"}</Button>
      </form>
      <p className="pin-footnote">忘记 PIN 无法直接恢复敏感设置。请保管好加密备份。</p>
    </section>
  </main>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
