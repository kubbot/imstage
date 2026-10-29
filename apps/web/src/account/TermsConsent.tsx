import { useLocale } from '../marketing/LocaleContext';
export function TermsConsent({ checked, onChange, testId = 'terms-consent' }: { checked: boolean; onChange: (value: boolean) => void; testId?: string }) {
  const { locale } = useLocale();
  return <label className="auth-terms"><input type="checkbox" data-testid={testId} required checked={checked} onChange={e => onChange(e.target.checked)} /><span>{locale === 'zh' ? <>我已阅读并同意 <a href="#/terms">使用条款</a> 与 <a href="#/privacy">隐私与留存</a>：仅限测试与学习用途；禁止伪造证据、欺诈、诽谤、冒充或误导性使用；所有输出默认带「AI生成 / 虚构」标识。</> : <>I have read and accept the <a href="#/terms">terms of use</a> and <a href="#/privacy">privacy &amp; retention</a> notices: testing and learning only; no fabricated evidence, fraud, defamation, impersonation or misleading use; outputs carry an “AI-generated / fictional” label by default.</>}</span></label>;
}
