import { useState } from 'react';
import SpiritBox from './spirit/SpiritBox';
import AnnotationFrame from './spirit/AnnotationFrame';
import { HERO_DEMO } from '../data/demo';
import { useSpiritSequence, type SpiritAnnotation } from '../lib/spirit';

const ROWS = [
  ['North America', '$1,842,000', '+12%'],
  ['Europe', '$1,204,500', '+9%'],
  ['Asia Pacific', '$986,300', '+21%'],
  ['Latin America', '$247,200', '+4%'],
];

export default function ScreenScene() {
  const [anns, setAnns] = useState<SpiritAnnotation[]>([]);
  const seq = useSpiritSequence(HERO_DEMO, {
    auto: true,
    onAnnotation: setAnns,
  });

  return (
    <div className="scene" data-ui data-fx="scene">
      <div className="scene__window" data-fx="parallax" data-speed="4">
        <div className="scene__chrome">
          <span className="scene__lights" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="scene__file">Q3-revenue.pdf</span>
          <span className="scene__page-count">3 of 8</span>
        </div>
        <div className="scene__page" style={{ position: 'relative' }}>
          <p className="scene__kicker">Finance · quarterly review</p>
          <h3>Q3 revenue by region</h3>
          <p className="scene__body">
            Growth held through the quarter, led by Asia Pacific. The table below is the summary
            finance circulated on Monday.
          </p>
          <table className="scene__table">
            <thead>
              <tr>
                <th scope="col">Region</th>
                <th scope="col">Revenue</th>
                <th scope="col">YoY</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(([region, revenue, growth]) => (
                <tr
                  key={region}
                  data-sann-target={region === 'Asia Pacific' ? 'apac' : undefined}
                  className={region === 'Asia Pacific' && anns.length > 0 ? 'is-target' : undefined}
                >
                  <td>{region}</td>
                  <td className="num">{revenue}</td>
                  <td className="num">{growth}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="scene__note">
            Full reconciliation and the tax adjustment sit in appendix B, page 8.
          </p>
          <AnnotationFrame annotations={anns} />
        </div>
      </div>

      <div className="scene__spirit" data-fx="slide" data-from="right">
        <SpiritBox
          seq={seq}
          demo={HERO_DEMO}
          phase={seq.phase}
          ctxChips={['Q3-revenue.pdf', 'table']}
          staticCursor
        />
      </div>
    </div>
  );
}
