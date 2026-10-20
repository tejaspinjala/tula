import { useState } from 'react'
import { PasskeyRequestError, type Session } from './passkeys'
import { type LedgerProposal, listProposals } from './proposals'

/** The Proposal view: each draft shows its exact content, hash and the Verdict's findings. */
export function ProposalPanel({ session }: { session: Session | null }) {
  const [proposals, setProposals] = useState<LedgerProposal[]>([])
  const [message, setMessage] = useState('')

  async function load(current: Session) {
    setMessage('Loading Proposals...')
    try {
      setProposals((await listProposals(current, fetch)).proposals)
      setMessage('')
    } catch (error) {
      setMessage(
        error instanceof PasskeyRequestError
          ? `Load Proposals refused: ${error.code}`
          : 'Load Proposals failed'
      )
    }
  }

  return (
    <section aria-labelledby="proposals-heading" className="mt-8">
      <h2 id="proposals-heading" className="text-xl font-semibold">
        Proposals
      </h2>
      {session ? (
        <div className="mt-4 flex flex-col gap-3">
          <button
            type="button"
            className="min-h-11 rounded border p-2"
            onClick={() => load(session)}
          >
            Load Proposals
          </button>
          <ul aria-label="Proposals" className="flex flex-col gap-3">
            {proposals.map((proposal) => (
              <li key={proposal.id} className="rounded border p-3">
                <p className="whitespace-pre-wrap">{proposal.content}</p>
                <p className="break-all text-xs">Hash: {proposal.hash}</p>
                <p className="text-sm">Verdict: {proposal.verdict.passed ? 'pass' : 'fail'}</p>
                <ul aria-label="Findings" className="text-sm">
                  {proposal.verdict.findings.map((f) => (
                    <li key={f.check}>
                      {f.passed ? 'pass' : 'fail'} {f.check}: {f.detail}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <p role="status">{message}</p>
        </div>
      ) : (
        <p className="mt-2">Sign in to see Proposals.</p>
      )}
    </section>
  )
}
