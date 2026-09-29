/**
 * Commercial contact copy for the dedicated dataset/annotation section.
 *
 * Pure helper (node-testable). When a verified business email is configured
 * (VITE_BUSINESS_EMAIL) surfaces show a real mailto link; otherwise a plain
 * "not published yet" state. GitHub is never the commercial contact. The
 * commercial offer is limited to separately agreed private / closed-source
 * test and evaluation datasets and annotation deliverables.
 */
export interface CommercialContactLine {
  /** mailto: href when a verified address exists, otherwise null. */
  href: string | null;
  text: string;
  note: string;
}

export function commercialContactLine(locale: 'zh' | 'en', email: string): CommercialContactLine {
  const available = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email.trim());
  const address = email.trim();
  if (locale === 'zh') {
    return {
      href: available ? `mailto:${address}` : null,
      text: available ? `邮件咨询：${address}` : '数据集合作联系邮箱：暂未公布。',
      note: available
        ? '测试集、Evaluation 数据集与标注集采用独立协议，非公开交付。'
        : '提供测试集、Evaluation 数据集与标注集的独立合作。',
    };
  }
  return {
    href: available ? `mailto:${address}` : null,
    text: available ? `Email enquiry: ${address}` : 'Dataset enquiries: not published yet.',
    note: available
      ? 'Private test sets, evaluation datasets and annotations, under separate agreements.'
      : 'Independent engagements for private test sets, evaluation datasets and annotations.',
  };
}
