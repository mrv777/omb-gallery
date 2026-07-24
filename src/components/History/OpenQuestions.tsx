import type { OpenQuestion } from '@/lib/history';

/**
 * The section that makes this a wiki rather than a brochure: what the public
 * record gets wrong, and what we still don't know. Doubles as the ask — a
 * reader who can fill a gap knows where to aim.
 */
export default function OpenQuestions({ questions }: { questions: readonly OpenQuestion[] }) {
  return (
    <div className="space-y-6">
      {questions.map(q => (
        <div key={q.id} className="border-l-2 border-ink-2 pl-4">
          <h3 className="font-mono text-sm text-bone uppercase tracking-[0.08em]">{q.question}</h3>
          <p className="font-mono mt-1.5 max-w-2xl text-[11px] leading-relaxed text-bone-dim">
            {q.whatWeKnow}
          </p>
          {q.sources.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
              {q.sources.map(s => (
                <a
                  key={s.href}
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[10px] uppercase tracking-[0.08em] text-bone-dim hover:text-bone underline underline-offset-4"
                >
                  {s.label} ↗
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
