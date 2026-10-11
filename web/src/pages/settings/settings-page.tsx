import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldSet,
} from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { applySavedLanguage } from '@/i18n';
import type { Locale } from '@/utils/locale';

type Settings = {
  language: Locale;
  feishu: {
    enabled: boolean;
    webhookConfigured: boolean;
    webhookUrl: string;
    maskedSecret: string;
    secretConfigured: boolean;
  };
  budget: {
    enabled: boolean;
    webhookConfigured: boolean;
    webhookUrl: string;
    thresholdCents: number;
  };
};
function maskedSecret(secret: string) {
  const characters = Array.from(secret);
  return characters.length > 8
    ? `${characters.slice(0, 4).join('')}••••••••${characters.slice(-4).join('')}`
    : '••••••••';
}
export function SettingsPage() {
  const { i18n, t } = useLingui();
  const [settings, setSettings] = useState<Settings>();
  const [feishuUrl, setFeishuUrl] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [budgetUrl, setBudgetUrl] = useState('');
  const [threshold, setThreshold] = useState('30000');
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'error'>(
    'loading',
  );
  const [errorCode, setErrorCode] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/settings', {
      cache: 'no-store',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = (await response.json()) as Settings;
        if (!controller.signal.aborted) {
          setSettings(data);
          setFeishuUrl(data.feishu.webhookUrl);
          setBudgetUrl(data.budget.webhookUrl);
          setThreshold(String(data.budget.thresholdCents));
          setStatus('ready');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setErrorCode('load');
          setStatus('error');
        }
      });
    return () => controller.abort();
  }, [attempt]);
  useEffect(
    () =>
      i18n.on('change', () => {
        const language = i18n.locale;
        if (language === 'en' || language === 'zh-CN') {
          setSettings((current) => (current ? { ...current, language } : current));
        }
      }),
    [i18n],
  );
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings || status === 'saving') return;
    setStatus('saving');
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          language: settings.language,
          feishu: {
            enabled: settings.feishu.enabled,
            webhookUrl: feishuUrl,
            signingSecret: secret ?? undefined,
            clearSigningSecret: secret !== null && secret.trim() === '',
          },
          budget: {
            enabled: settings.budget.enabled,
            webhookUrl: budgetUrl,
            thresholdCents: Number(threshold),
          },
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setErrorCode(data.error ?? 'save');
        setStatus('error');
        return;
      }
      setSettings(data);
      applySavedLanguage(data.language);
      setFeishuUrl(data.feishu.webhookUrl);
      setSecret(null);
      setShowSecret(false);
      setBudgetUrl(data.budget.webhookUrl);
      setStatus('saved');
    } catch {
      setErrorCode('save');
      setStatus('error');
    }
  };
  const error =
    errorCode === 'invalid_feishu'
      ? t`请填写有效的飞书机器人 Webhook 地址。`
      : errorCode === 'invalid_budget'
        ? t`请填写有效的预算 Webhook 地址。`
        : errorCode === 'invalid_threshold'
          ? t`预算阈值必须是正整数，单位为美元分。`
          : t`设置加载或保存失败`;
  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight">
        <Trans>设置</Trans>
      </h2>
      {status === 'loading' ? (
        <p role="status">
          <Trans>加载中…</Trans>
        </p>
      ) : !settings ? (
        <div role="alert" className="flex items-center gap-3">
          {error}
          <Button
            variant="outline"
            onClick={() => {
              setStatus('loading');
              setAttempt((value) => value + 1);
            }}
          >
            <Trans>重试</Trans>
          </Button>
        </div>
      ) : (
        <form
          onSubmit={(event) => void save(event)}
          onChange={() => {
            if (status === 'saved') setStatus('ready');
          }}
          className="w-full space-y-6"
        >
          <FieldSet
            disabled={status === 'saving'}
            className="grid items-start gap-6 disabled:opacity-60 lg:grid-cols-2"
          >
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>
                    <Trans>基础</Trans>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Field>
                    <FieldLabel htmlFor="application-language">
                      <Trans>语言</Trans>
                    </FieldLabel>
                    <Select
                      value={settings.language}
                      onValueChange={(value) => {
                        if (value === 'en' || value === 'zh-CN') {
                          setSettings({ ...settings, language: value });
                          if (status === 'saved') setStatus('ready');
                        }
                      }}
                      disabled={status === 'saving'}
                    >
                      <SelectTrigger id="application-language">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent position="popper">
                        <SelectGroup>
                          <SelectItem value="zh-CN">简体中文</SelectItem>
                          <SelectItem value="en">English</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>
                    <Trans>飞书通知</Trans>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <FieldGroup>
                    <Field orientation="horizontal">
                      <Checkbox
                        id="feishu-enabled"
                        disabled={status === 'saving'}
                        checked={settings.feishu.enabled}
                        onCheckedChange={(checked) => {
                          setSettings({
                            ...settings,
                            feishu: { ...settings.feishu, enabled: checked === true },
                          });
                          if (status === 'saved') setStatus('ready');
                        }}
                      />
                      <FieldLabel htmlFor="feishu-enabled">
                        <Trans>启用飞书通知</Trans>
                      </FieldLabel>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="feishu-webhook">
                        <Trans>飞书 Webhook 地址</Trans>
                      </FieldLabel>
                      <Input
                        id="feishu-webhook"
                        type="url"
                        autoComplete="off"
                        value={feishuUrl}
                        onChange={(event) => setFeishuUrl(event.target.value)}
                        placeholder={
                          settings.feishu.webhookConfigured ? t`已配置，留空保留` : t`尚未配置`
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="feishu-secret">
                        <Trans>签名密钥</Trans>
                      </FieldLabel>
                      <div className="relative">
                        <Input
                          id="feishu-secret"
                          type={showSecret ? 'text' : 'password'}
                          autoComplete="new-password"
                          className="pr-10"
                          value={
                            secret === null
                              ? settings.feishu.maskedSecret
                              : showSecret && secret
                                ? maskedSecret(secret)
                                : secret
                          }
                          readOnly={showSecret}
                          onFocus={(event) => {
                            if (!showSecret && secret === null) event.currentTarget.select();
                          }}
                          onChange={(event) => {
                            // The saved preview is not an editable secret. Selecting it and
                            // typing replaces it; deleting it explicitly clears the secret.
                            const value = event.target.value;
                            if (secret === null && value.includes('•')) return;
                            setSecret(value);
                          }}
                          placeholder={t`可选`}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="absolute inset-y-0 right-0.5 my-auto active:not-aria-[haspopup]:translate-y-0"
                          disabled={status === 'saving'}
                          aria-label={showSecret ? t`隐藏密钥` : t`显示脱敏密钥`}
                          aria-pressed={showSecret}
                          onClick={() => setShowSecret((value) => !value)}
                        >
                          {showSecret ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                        </Button>
                      </div>
                    </Field>
                  </FieldGroup>
                </CardContent>
              </Card>
            </div>
            <Card>
              <CardHeader>
                <CardTitle>
                  <Trans>预算通知</Trans>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field orientation="horizontal">
                    <Checkbox
                      id="budget-enabled"
                      disabled={status === 'saving'}
                      checked={settings.budget.enabled}
                      onCheckedChange={(checked) => {
                        setSettings({
                          ...settings,
                          budget: { ...settings.budget, enabled: checked === true },
                        });
                        if (status === 'saved') setStatus('ready');
                      }}
                    />
                    <FieldLabel htmlFor="budget-enabled">
                      <Trans>启用预算通知</Trans>
                    </FieldLabel>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="budget-webhook">
                      <Trans>预算 Webhook 地址</Trans>
                    </FieldLabel>
                    <Input
                      id="budget-webhook"
                      type="url"
                      autoComplete="off"
                      value={budgetUrl}
                      onChange={(event) => setBudgetUrl(event.target.value)}
                      placeholder={
                        settings.budget.webhookConfigured ? t`已配置，留空保留` : t`尚未配置`
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="budget-threshold">
                      <Trans>预算阈值（美元分）</Trans>
                    </FieldLabel>
                    <Input
                      id="budget-threshold"
                      aria-describedby="budget-threshold-description"
                      type="number"
                      min="1"
                      max={Number.MAX_SAFE_INTEGER}
                      step="1"
                      required
                      value={threshold}
                      onChange={(event) => setThreshold(event.target.value)}
                    />
                    <FieldDescription id="budget-threshold-description">
                      <Trans>30000 表示 300 美元，严格超过阈值时每账期通知一次。</Trans>
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </CardContent>
            </Card>
          </FieldSet>
          <FieldDescription>
            <Trans>
              保存后覆盖环境变量中的通知配置，无需重启。停用后暂停发送，待发送通知会保留。
            </Trans>
          </FieldDescription>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={status === 'saving'}>
              {status === 'saving' ? t`保存中…` : t`保存设置`}
            </Button>
            {status === 'saved' && (
              <span role="status" className="text-sm">
                <Trans>设置已保存</Trans>
              </span>
            )}
            {status === 'error' && <FieldError>{error}</FieldError>}
          </div>
        </form>
      )}
    </>
  );
}
