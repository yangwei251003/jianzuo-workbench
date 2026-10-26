import { useEffect, useState, type FormEvent } from "react";
import { Key, ShieldWarning } from "@phosphor-icons/react";
import { Button, InlineAlert } from "./ui";

export type EmergencyResumePayload = {
  pin: string;
  confirmation: "RESUME_AUTOMATION";
  acknowledgeResultUnknown: boolean;
};

type Props = {
  open: boolean;
  resultUnknownActions: number;
  loading?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: (payload: EmergencyResumePayload) => void;
};

export function EmergencyResumeDialog({ open, resultUnknownActions, loading = false, error, onCancel, onConfirm }: Props) {
  const [pin, setPin] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (open) {
      setPin("");
      setAcknowledged(false);
    }
  }, [open]);

  if (!open) return null;
  const hasUnknown = resultUnknownActions > 0;
  const validPin = /^\d{6,12}$/.test(pin);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!validPin || (hasUnknown && !acknowledged)) return;
    onConfirm({ pin, confirmation: "RESUME_AUTOMATION", acknowledgeResultUnknown: hasUnknown && acknowledged });
  };

  return <div className="safety-dialog-backdrop" role="presentation">
    <section className="safety-dialog" role="dialog" aria-modal="true" aria-labelledby="resume-title">
      <form onSubmit={submit}>
        <div className="safety-dialog-heading"><span><ShieldWarning size={28} /></span><div><p className="eyebrow">高风险操作</p><h2 id="resume-title">恢复所有自动化写操作</h2></div></div>
        <p>恢复后，新批准的 Outbox 动作和扩展写操作可以继续执行。系统不会重放任何“结果未知”动作。</p>
        {hasUnknown && <InlineAlert tone="danger" title={`仍有 ${resultUnknownActions} 个结果未知动作`}>
          它们会继续封存。请先确认待办列表，绝不要因为恢复自动化而手工重复提交。
        </InlineAlert>}
        <label className="safety-pin-field"><span>当前本地 PIN</span><div><Key size={18} /><input autoFocus type="password" inputMode="numeric" autoComplete="current-password" value={pin} onChange={(event) => setPin(event.target.value)} placeholder="输入 6–12 位 PIN" /></div></label>
        {hasUnknown && <label className="check-control"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span><strong>我确认未知结果仍需逐条人工核验</strong><small>恢复不会改变这些动作的封存状态。</small></span></label>}
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
        <div className="safety-dialog-actions"><Button type="button" variant="ghost" onClick={onCancel} disabled={loading}>取消</Button><Button type="submit" variant="danger" loading={loading} disabled={!validPin || (hasUnknown && !acknowledged)}>验证 PIN 并恢复</Button></div>
      </form>
    </section>
  </div>;
}

