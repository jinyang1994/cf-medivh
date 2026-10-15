import { useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

export type McpSettings = {
  enabled: boolean;
  maskedToken: string;
  updatedAt: string | null;
  endpoint: '/mcp';
};

export type McpDraft = { action: 'rotate'; token: string } | { action: 'revoke' };

type McpSettingsCardProps = {
  settings: McpSettings;
  draft: McpDraft | null;
  savedToken: string;
  saving: boolean;
  generating: boolean;
  onGenerate: () => Promise<void>;
  onDraftChange: (draft: McpDraft | null) => void;
};

export function McpSettingsCard({
  settings,
  draft,
  savedToken,
  saving,
  generating,
  onGenerate,
  onDraftChange,
}: McpSettingsCardProps) {
  const { t } = useLingui();
  const [error, setError] = useState(false);
  const [confirmation, setConfirmation] = useState<'rotate' | 'revoke'>('rotate');
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [copyResult, setCopyResult] = useState<{
    token: string;
    status: 'copied' | 'failed';
  } | null>(null);
  const tokenInput = useRef<HTMLInputElement>(null);
  const primaryAction = useRef<HTMLButtonElement>(null);
  const confirmationTrigger = useRef<HTMLButtonElement | null>(null);
  const busy = saving || generating;
  const token = draft?.action === 'rotate' ? draft.token : savedToken;
  const hasToken = settings.enabled || draft?.action === 'rotate';
  const copyStatus = copyResult?.token === token ? copyResult.status : null;

  const openConfirmation = (action: 'rotate' | 'revoke', trigger: HTMLButtonElement) => {
    confirmationTrigger.current = trigger;
    setConfirmation(action);
    setError(false);
    setConfirmationOpen(true);
  };

  const generateToken = async () => {
    if (busy) return;
    setError(false);
    try {
      await onGenerate();
      setConfirmationOpen(false);
    } catch {
      setError(true);
    }
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopyResult({ token, status: 'copied' });
    } catch {
      tokenInput.current?.focus();
      tokenInput.current?.select();
      setCopyResult({ token, status: 'failed' });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Trans>MCP 访问</Trans>
        </CardTitle>
        <CardDescription>
          <Trans>允许 Agent 通过 MCP 只读查询费用明细。</Trans>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <div role="status" className="text-sm">
            {settings.enabled ? t`MCP 已启用` : t`MCP 已停用`}
          </div>
          {draft && (
            <p role="status" className="rounded-md border bg-muted/50 p-3 text-sm">
              {draft.action === 'revoke'
                ? t`停用待保存。点击“保存设置”后停用，保存前当前密钥继续有效。`
                : settings.enabled
                  ? t`新密钥待保存。点击“保存设置”后生效，保存前旧密钥继续有效。`
                  : t`新密钥待保存。点击“保存设置”后启用 MCP。`}
            </p>
          )}
          <Field>
            <FieldLabel htmlFor="mcp-endpoint">
              <Trans>连接地址</Trans>
            </FieldLabel>
            <Input
              id="mcp-endpoint"
              readOnly
              value={new URL(settings.endpoint, window.location.origin).href}
              className="font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />
            <FieldDescription>
              <Trans>
                客户端使用 Streamable HTTP，并在 Authorization 请求头中填写 Bearer 加空格和密钥。
              </Trans>
            </FieldDescription>
          </Field>
          {hasToken && (
            <Field>
              <FieldLabel htmlFor="mcp-token">
                {draft?.action === 'rotate' ? t`待保存密钥` : t`访问密钥`}
              </FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  ref={tokenInput}
                  id="mcp-token"
                  aria-describedby="mcp-token-description"
                  readOnly
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-0 font-mono text-xs"
                  value={token || settings.maskedToken}
                  onFocus={(event) => event.currentTarget.select()}
                />
                {token && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void copyToken()}
                  >
                    <Copy aria-hidden="true" />
                    {copyStatus === 'copied' ? t`已复制` : t`复制`}
                  </Button>
                )}
              </div>
              <FieldDescription id="mcp-token-description">
                {token
                  ? t`请立即复制并妥善保存。完整密钥仅在本次生成后显示，离开或刷新页面后无法再次查看。`
                  : t`已保存的密钥仅显示脱敏预览。若已遗失，请重新生成并更新客户端。`}
              </FieldDescription>
              {copyStatus === 'failed' && (
                <FieldError>
                  <Trans>自动复制失败，请选中密钥后手动复制。</Trans>
                </FieldError>
              )}
            </Field>
          )}
          <FieldDescription>
            <Trans>MCP 更改仅在点击“保存设置”后生效。离开或刷新页面将丢弃未保存的更改。</Trans>
          </FieldDescription>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={primaryAction}
              type="button"
              variant="outline"
              disabled={busy}
              aria-haspopup={hasToken ? 'dialog' : undefined}
              onClick={(event) => {
                if (hasToken) openConfirmation('rotate', event.currentTarget);
                else void generateToken();
              }}
            >
              {generating ? t`处理中…` : hasToken ? t`重新生成密钥` : t`生成密钥`}
            </Button>
            {settings.enabled && draft?.action !== 'revoke' && (
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                aria-haspopup="dialog"
                onClick={(event) => openConfirmation('revoke', event.currentTarget)}
              >
                <Trans>停用 MCP</Trans>
              </Button>
            )}
            {draft && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  onDraftChange(null);
                  setError(false);
                  setCopyResult(null);
                }}
              >
                <Trans>取消 MCP 更改</Trans>
              </Button>
            )}
          </div>
          <AlertDialog
            open={confirmationOpen}
            onOpenChange={(open) => {
              if (busy) return;
              setConfirmationOpen(open);
              if (!open) setError(false);
            }}
          >
            <AlertDialogContent
              aria-busy={busy}
              onEscapeKeyDown={(event) => {
                if (busy) event.preventDefault();
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                const trigger = confirmationTrigger.current;
                (trigger?.isConnected ? trigger : primaryAction.current)?.focus();
              }}
            >
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {confirmation === 'rotate' ? t`重新生成密钥` : t`停用 MCP`}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {confirmation === 'revoke'
                    ? t`点击“保存设置”后才会停用 MCP，保存前当前密钥继续有效。`
                    : settings.enabled
                      ? t`新密钥仅在点击“保存设置”后生效，届时旧密钥失效，已连接的 Agent 需要更新密钥。`
                      : t`重新生成将替换待保存密钥，点击“保存设置”后才会启用 MCP。`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              {error && (
                <FieldError>
                  <Trans>密钥生成失败，请重试。当前已保存的密钥不受影响。</Trans>
                </FieldError>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel type="button" disabled={busy}>
                  <Trans>取消</Trans>
                </AlertDialogCancel>
                <AlertDialogAction
                  type="button"
                  variant={confirmation === 'revoke' ? 'destructive' : 'default'}
                  disabled={busy}
                  onClick={(event) => {
                    event.preventDefault();
                    if (confirmation === 'rotate') {
                      void generateToken();
                    } else {
                      onDraftChange({ action: 'revoke' });
                      setConfirmationOpen(false);
                    }
                  }}
                >
                  {generating
                    ? t`处理中…`
                    : confirmation === 'rotate'
                      ? t`确认重新生成`
                      : t`确认停用`}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {error && !confirmationOpen && (
            <FieldError>
              <Trans>密钥生成失败，请重试。当前已保存的密钥不受影响。</Trans>
            </FieldError>
          )}
        </FieldGroup>
      </CardContent>
    </Card>
  );
}
