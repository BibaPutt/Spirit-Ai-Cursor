import { useEffect, useId, useState } from 'react';
import type {
  SpiritChipIcon,
  SpiritDemo,
  SpiritPhase,
  SpiritSeqState,
} from '../../lib/spirit';
import { SUGGESTION_CHIPS } from '../../data/demo';
import { useI18n } from '../../i18n';
import AnswerBlocks from './AnswerBlocks';
import BibataCursor from './BibataCursor';

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2 .01 7Z" />
    </svg>
  );
}

function CheckIcon({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 14 14" width={size} height={size} fill="none" aria-hidden="true">
      <path
        d="M3 7.5 5.8 10 11 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="3.5" width="11" height="7.5" rx="1.1" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="7" cy="7.25" r="1.8" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 3.5l.6-1.2h2.8L9 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function WindowIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.5 5.5h11M4.5 9.5h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" fill="none" aria-hidden="true">
      <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function LoaderOrb() {
  const maskId = `sbox-loader-${useId().replace(/:/g, '')}`;
  return (
    <span className="sbox__loader" aria-hidden="true">
      <svg width="100" height="100" viewBox="0 0 100 100">
        <defs>
          <mask id={maskId} className="sbox__loader-mask">
            <polygon points="0,0 100,0 100,100 0,100" fill="black" />
            <polygon points="28.75,28.75 71.25,28.75 50,71.25" fill="white" />
            <polygon points="50,28.75 71.25,71.25 28.75,71.25" fill="white" />
            <polygon points="37.25,37.25 62.75,37.25 50,62.75" fill="white" />
            <polygon points="37.25,37.25 62.75,37.25 50,62.75" fill="white" />
            <polygon points="37.25,37.25 62.75,37.25 50,62.75" fill="white" />
            <polygon points="37.25,37.25 62.75,37.25 50,62.75" fill="white" />
          </mask>
        </defs>
      </svg>
      <div className="sbox__loader-orb">
        <div
          className="sbox__loader-box"
          style={{ maskImage: `url(#${maskId})`, WebkitMaskImage: `url(#${maskId})` }}
        />
      </div>
    </span>
  );
}

function ChipIcon({ kind }: { kind: SpiritChipIcon }) {
  if (kind === 'copy') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
        <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === 'save') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 5h11l3 3v11H5V5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M8 5v5h7V5M8 19v-5h8v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === 'export') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 4v11M8 8l4-4 4 4M5 16v3h14v-3"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === 'table') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
        <path d="M3 10h18M9 4v16M15 4v16" stroke="currentColor" strokeWidth="2" />
      </svg>
    );
  }
  if (kind === 'bulb') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.6 1 2.5h6c0-.9.3-1.8 1-2.5A6 6 0 0 0 12 3Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === 'chart') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === 'list') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export type SpiritBoxProps = {
  seq: SpiritSeqState;
  demo: SpiritDemo | null;
  phase: SpiritPhase;
  ctxChips?: string[];
  placeholder?: string;
  className?: string;
  onRail?: (label: string) => void;
  staticCursor?: boolean;
  questions?: SpiritDemo[];
  questionsOpen?: boolean;
  activeQuestionId?: string;
  onQuestion?: (index: number) => void;
  onQuestionsClose?: () => void;
};

export default function SpiritBox({
  seq,
  demo,
  phase,
  ctxChips,
  placeholder,
  className = '',
  onRail,
  staticCursor = false,
  questions,
  questionsOpen = false,
  activeQuestionId,
  onQuestion,
  onQuestionsClose,
}: SpiritBoxProps) {
  const { t } = useI18n();
  const resolvedPlaceholder = placeholder ?? t('spirit.placeholder');
  const [shotDismissed, setShotDismissed] = useState(false);

  useEffect(() => {
    setShotDismissed(false);
  }, [demo?.id]);

  const pickerOpen = Boolean(questionsOpen && questions && questions.length > 0);
  const showAnswer = phase === 'thinking' || phase === 'streaming' || phase === 'done';
  const expanded = showAnswer && !pickerOpen;
  const chipsInRail = phase === 'streaming' || phase === 'done';
  const busy = phase === 'thinking' || phase === 'streaming';
  const headDone = phase === 'streaming' || phase === 'done';
  const showFloating = phase === 'idle' || phase === 'typing';

  const steps = demo?.steps ?? [];
  const shownSteps = phase === 'idle' || phase === 'typing' ? [] : steps;
  const activeStep =
    phase === 'thinking' || (phase === 'streaming' && seq.blocksShown === 0)
      ? Math.min(seq.stepIndex, steps.length - 1)
      : -1;
  const blocks = demo?.blocks.slice(0, seq.blocksShown) ?? [];
  const chips = demo?.chips ?? SUGGESTION_CHIPS;
  const hasText = seq.promptShown.length > 0 || phase === 'done';
  const sendLive = phase === 'typing' && hasText;
  const appLabel = ctxChips?.[0] ?? demo?.file ?? 'Q3-revenue.pdf';

  return (
    <div
      className={`sbox${chipsInRail && !pickerOpen ? ' is-rail' : ''}${expanded ? ' is-expanded' : ''}${pickerOpen ? ' is-picking' : ''} ${className}`.trim()}
      data-ui
    >
      {staticCursor && <BibataCursor className="sbox__cursor" />}
      <div className={`sbox__floating${showFloating ? '' : ' is-hidden'}`}>
        {!shotDismissed && (
          <div className="sbox__fchip sbox-glass is-dismissible">
            <span className="sbox__fchip-ico">
              <CameraIcon />
            </span>
            <span className="sbox__fchip-short">{t('spirit.shotShort')}</span>
            <span className="sbox__fchip-full">{t('spirit.shot')}</span>
            <button
              type="button"
              className="sbox__fchip-x"
              aria-label={t('spirit.removeShot')}
              title={t('spirit.removeShot')}
              onClick={() => setShotDismissed(true)}
            >
              <XIcon />
            </button>
          </div>
        )}
        <div className="sbox__fchip sbox-glass">
          <span className="sbox__fchip-ico">
            <WindowIcon />
          </span>
          <span className="sbox__fchip-short">{t('spirit.app')}</span>
          <span className="sbox__fchip-full">{appLabel}</span>
        </div>
      </div>

      <div className="sbox__stack">
        <div className="sbox__wrap sbox__wrap--beam">
          <div className="sbox__card sbox-glass">
            <span className="sbox__grip" aria-hidden="true" />

            <div className="sbox__row">
              <span className="sbox__mic" aria-hidden="true">
                {busy ? <LoaderOrb /> : <span className="sbox__idle-dot" />}
              </span>

              <div className="sbox__field">
                <span className={`sbox__text${hasText ? '' : ' is-placeholder'}`}>
                  {hasText ? (
                    <>
                      {phase === 'done' && demo ? demo.prompt : seq.promptShown}
                      {phase === 'typing' && <span className="sbox__caret" />}
                    </>
                  ) : (
                    resolvedPlaceholder
                  )}
                </span>
              </div>

              <span
                className={`sbox__send${sendLive ? ' is-live' : ''}`}
                aria-hidden="true"
              >
                <SendIcon />
                <span className="sbox__send-label">{t('spirit.send')}</span>
              </span>
            </div>

            {pickerOpen && questions && (
              <div className="sbox__picker" role="dialog" aria-label={t('spirit.questions')}>
                <div className="sbox__picker-head">
                  <span>{t('spirit.pickQuestion')}</span>
                  <button
                    type="button"
                    className="sbox__picker-x"
                    aria-label={t('spirit.closeQuestions')}
                    title={t('spirit.closeQuestions')}
                    onClick={onQuestionsClose}
                  >
                    <XIcon />
                  </button>
                </div>

                <div className="sbox__picker-list" role="listbox" aria-label={t('spirit.questions')}>
                  {questions.map((q, i) => {
                    const active = q.id === activeQuestionId;
                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        key={q.id}
                        className={`sbox__picker-item${active ? ' is-active' : ''}`}
                        onClick={() => onQuestion?.(i)}
                      >
                        <span className="sbox__picker-num">{i + 1}</span>
                        <span className="sbox__picker-label">{q.prompt}</span>
                        {active && (
                          <span className="sbox__picker-check" aria-hidden="true">
                            <CheckIcon />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                <div className="sbox__picker-foot">
                  <span>
                    <kbd>1</kbd>–<kbd>{questions.length}</kbd> {t('spirit.pickHint')}
                  </span>
                  <span>
                    <kbd>Esc</kbd> {t('spirit.dismiss')}
                  </span>
                </div>
              </div>
            )}

            <div className="sbox__answer">
              <div className="sbox__answer-in">
                <div className="sbox__answer-pad">
                  {showAnswer && !pickerOpen && (
                    <>
                      <div className="sbox__steps-head">
                        {headDone ? (
                          <>
                            <span className="sbox__step-ico is-done">
                              <CheckIcon />
                            </span>
                            <span>
                              {t('spirit.thought', { secs: (demo?.elapsedSecs ?? 1.8).toFixed(1) })}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="sbox__spin" aria-hidden="true" />
                            <span>{t('spirit.thinking')}</span>
                          </>
                        )}
                      </div>

                      {shownSteps.length > 0 && (
                        <div className={`sbox__steps${headDone ? ' is-collapsed' : ''}`}>
                          {shownSteps.map((s, i) => {
                            const live = phase === 'thinking';
                            const state = live
                              ? i < activeStep
                                ? 'done'
                                : i === activeStep
                                  ? 'run'
                                  : 'wait'
                              : 'done';
                            if (state === 'wait') return null;
                            return (
                              <div className={`sbox__step${state === 'run' ? ' is-run' : ''}`} key={s}>
                                <span className={`sbox__step-ico${state === 'done' ? ' is-done' : ''}`}>
                                  {state === 'done' ? <CheckIcon /> : <span className="sbox__spin" />}
                                </span>
                                {s}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {blocks.length > 0 && <AnswerBlocks blocks={blocks} />}
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          <span className={`sbox__glow${busy ? ' is-on' : ''}`} aria-hidden="true" />
        </div>

        {chips.length > 0 && !pickerOpen && (
          <div className="sbox__chips">
            {chips.map((chip, i) => (
              <button
                type="button"
                className="sbox__chip sbox-glass"
                key={chip.label}
                style={{ animationDelay: `${i * 0.05}s` }}
                onClick={() => onRail?.(chip.label)}
              >
                {chip.icon && <ChipIcon kind={chip.icon} />}
                <span>{chip.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
