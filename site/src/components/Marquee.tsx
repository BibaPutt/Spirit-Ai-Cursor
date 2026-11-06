import Mark from './Mark';
import { useI18n } from '../i18n';

const PHRASES = [
  'marquee.alt',
  'marquee.reads',
  'marquee.answers',
  'marquee.points',
  'marquee.local',
  'marquee.any',
];

export default function Marquee() {
  const { t } = useI18n();

  return (
    <div className="marquee" data-fx="marquee" aria-label={t('marquee.label')}>
      <div className="marquee__track">
        {[0, 1].map((copy) => (
          <div className="marquee__group" key={copy} aria-hidden={copy === 1}>
            {PHRASES.map((phrase) => (
              <span className="marquee__item" key={phrase}>
                <span>{t(phrase)}</span>
                <span className="marquee__sep">
                  <Mark size={18} />
                </span>
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
