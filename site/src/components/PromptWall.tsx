import { useI18n } from '../i18n';

const COLUMNS: string[][] = [
  ['wall.0.0', 'wall.0.1', 'wall.0.2', 'wall.0.3'],
  ['wall.1.0', 'wall.1.1', 'wall.1.2', 'wall.1.3'],
  ['wall.2.0', 'wall.2.1', 'wall.2.2', 'wall.2.3'],
];

export default function PromptWall() {
  const { t } = useI18n();

  return (
    <div className="wall" aria-label={t('wall.label')}>
      {COLUMNS.map((column, index) => (
        <div
          className="wall__col"
          data-prompt-col={index}
          data-dir={index % 2 === 0 ? 'up' : 'down'}
          key={index}
        >
          {[0, 1].map((copy) => (
            <div className="wall__group" aria-hidden={copy === 1} key={copy}>
              {column.map((question) => (
                <figure className="prompt" key={`${copy}-${question}`}>
                  <blockquote>{t(question)}</blockquote>
                </figure>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
