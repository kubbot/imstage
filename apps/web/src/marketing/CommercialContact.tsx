/**
 * Dataset commercial enquiry block: mailto link or honest unavailable state.
 * The copy logic lives in `commercialCopy.ts` (pure, unit-tested).
 */
import type { ReactElement } from 'react';
import { BUSINESS_EMAIL, businessEmailAvailable } from '../config';
import { commercialContactLine } from './commercialCopy';

/** Dataset commercial enquiry block: mailto link or honest unavailable state. */
export function CommercialContact({ locale }: { locale: 'zh' | 'en' }): ReactElement {
  const line = commercialContactLine(locale, businessEmailAvailable ? BUSINESS_EMAIL : '');
  return (
    <div className="mark-commercial-contact" data-testid="commercial-contact">
      <p>
        {line.href ? (
          <a className="mark-btn mark-btn-primary" href={line.href} data-testid="commercial-mailto">{line.text}</a>
        ) : (
          <span className="mark-commercial-pending" data-testid="commercial-pending">{line.text}</span>
        )}
      </p>
      <p className="mark-note">{line.note}</p>
    </div>
  );
}
