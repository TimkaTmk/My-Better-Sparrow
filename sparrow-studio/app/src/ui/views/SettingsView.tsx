import { useState } from 'react';
import {
  MAX_SOLVER_THREADS,
  parseManualThreadCount,
  SOLVER_THREADS_ERROR,
} from '../../../../web/src/solverThreads';
import type { Preset, TimeLimit } from '../../engine/model';
import { TIME_LIMITS, type SolverSettings } from '../../project/model';
import { ProTag } from '../ProTag';
import { useStudio } from '../context';
import { RunBar } from '../RunBar';
import { Explanation } from './Explanation';

type Item = 'solve' | 'time' | 'search' | 'threads';

const timeLabel = (limit: TimeLimit) =>
  limit === null
    ? 'Automatic: stop when the search stalls'
    : limit < 60
      ? `Up to ${limit} seconds`
      : `Up to ${limit / 60} minute${limit > 60 ? 's' : ''}`;
const threadsLabel = (threads: number) => (threads === 0 ? 'Automatic' : String(threads));
const sharedMemory = globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';

export function SettingsView() {
  const { project, edit, threadDraft, setThreadDraft } = useStudio();
  const settings = project.settings;
  const [selected, setSelected] = useState<Item | undefined>('solve');
  const update = (change: Partial<SolverSettings>, key?: string) =>
    edit((current) => ({ ...current, settings: { ...current.settings, ...change } }), key);
  const items: { id: Item; name: string; summary: string }[] = [
    { id: 'solve', name: 'Solve with', summary: 'Local: in this browser' },
    { id: 'time', name: 'Time and stopping', summary: timeLabel(settings.timeLimitSeconds) },
    {
      id: 'search',
      name: 'Search preset',
      summary: settings.preset === 'fast' ? 'Fast' : 'Standard',
    },
    { id: 'threads', name: 'Solver threads', summary: threadsLabel(settings.threads) },
  ];
  return (
    <div className="view">
      <section className="list-panel" aria-label="Optimization settings">
        <div className="list-head">
          <span className="label">Optimization</span>
        </div>
        <div className="list-scroll">
          {items.map((item) => (
            <div key={item.id}>
              <button
                className={item.id === selected ? 'row selected' : 'row'}
                aria-expanded={item.id === selected}
                onClick={() => setSelected(item.id === selected ? undefined : item.id)}
              >
                <span className="row-text">
                  <span>{item.name}</span>
                  <span className="muted">{item.summary}</span>
                </span>
              </button>
              {item.id === selected && (
                <div className="properties">
                  {item.id === 'solve' && (
                    <>
                      <label className="choice">
                        <input type="radio" name="solve-with" checked readOnly />
                        <span>
                          Local: in this browser
                          <span className="muted block">
                            Free, no account. One strip of open length.
                          </span>
                        </span>
                      </label>
                      <div className="choice disabled">
                        <input type="radio" name="solve-with" disabled aria-label="sparrow pro" />
                        <span className="grow">
                          sparrow pro
                          <span className="muted block">
                            Sheets, remnants, defects, clamps and reflection.
                          </span>
                        </span>
                        <ProTag />
                      </div>
                    </>
                  )}
                  {item.id === 'time' && (
                    <label className="field">
                      Stop condition
                      <select
                        value={String(settings.timeLimitSeconds)}
                        onChange={(event) =>
                          update({
                            timeLimitSeconds: (event.target.value === 'null'
                              ? null
                              : Number(event.target.value)) as TimeLimit,
                          })
                        }
                      >
                        {TIME_LIMITS.map((limit) => (
                          <option key={String(limit)} value={String(limit)}>
                            {timeLabel(limit)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {item.id === 'search' && (
                    <label className="field">
                      Search preset
                      <select
                        value={settings.preset}
                        onChange={(event) => update({ preset: event.target.value as Preset })}
                      >
                        <option value="standard">Standard</option>
                        <option value="fast">Fast</option>
                      </select>
                    </label>
                  )}
                  {item.id === 'threads' && (
                    <>
                      <label className="field">
                        Solver threads
                        <input
                          inputMode="numeric"
                          placeholder="Automatic"
                          value={
                            threadDraft ?? (settings.threads === 0 ? '' : String(settings.threads))
                          }
                          aria-invalid={threadDraft !== undefined}
                          aria-describedby={
                            threadDraft !== undefined ? 'solver-threads-error' : undefined
                          }
                          onChange={(event) => {
                            const text = event.target.value;
                            const threads = parseManualThreadCount(text);
                            setThreadDraft(threads === undefined ? text : undefined);
                            if (threads !== undefined && threads !== settings.threads) {
                              update({ threads }, 'solver-threads');
                            }
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={settings.threads === 0 && threadDraft === undefined}
                        onClick={() => {
                          setThreadDraft(undefined);
                          if (settings.threads !== 0) update({ threads: 0 });
                        }}
                      >
                        Use automatic
                      </button>
                      {threadDraft !== undefined && (
                        <span id="solver-threads-error" className="field-error" role="alert">
                          {SOLVER_THREADS_ERROR}
                        </span>
                      )}
                      {!sharedMemory && (
                        <span className="muted">This browser session runs one thread.</span>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          <p className="muted pad">The gap and other machine settings are in the Machine tab.</p>
        </div>
        <RunBar />
      </section>
      <SettingsExplanation item={selected ?? 'solve'} />
    </div>
  );
}

function SettingsExplanation({ item }: { item: Item }) {
  if (item === 'solve')
    return (
      <Explanation title="Local or sparrow pro">
        <div className="compare">
          <div>
            <strong>Local</strong>
            <span>Runs sparrow on your computer, in this browser.</span>
            <span>Free, no account.</span>
            <span>One strip of open length.</span>
          </div>
          <div>
            <strong>sparrow pro</strong>
            <span>Runs on sparrow pro, the hosted solver. Needs signing in.</span>
            <span>Sheets in order, remnants and irregular sheets.</span>
            <span>Defects, clamps and reflection.</span>
          </div>
        </div>
        <p className="muted">The same project can be solved either way.</p>
      </Explanation>
    );
  if (item === 'time')
    return (
      <Explanation title="Time and stopping">
        <p>
          Automatic keeps searching while the layout still improves, then stops. A time limit stops
          at the limit at the latest. You can stop any run yourself; the best valid layout found so
          far is kept.
        </p>
        <p className="muted">
          Settings apply to the next run. They do not change the current solution.
        </p>
      </Explanation>
    );
  if (item === 'search')
    return (
      <Explanation title="Search preset">
        <p>
          Standard searches more thoroughly for the best final layout. Fast commits to promising
          layouts earlier: good results sooner, sometimes a longer final length.
        </p>
      </Explanation>
    );
  return (
    <Explanation title="Solver threads">
      <p>
        Automatic leaves one processor core free and uses up to 3 threads. For a manual count, enter
        a whole number from 1 to {MAX_SOLVER_THREADS}. The number the browser can start depends on
        available resources.
      </p>
      <p className="muted">
        Several threads need a browser session with shared memory. Otherwise, sparrow runs one
        thread.
      </p>
    </Explanation>
  );
}
