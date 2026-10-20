import { useState } from 'react'
import { PasskeyRequestError, type Session } from './passkeys'
import { type LedgerProposal, listProposals } from './proposals'
import { PixelButton } from './ui/pixel'
import { WorkSection } from './WorkSection'

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
    <WorkSection id="proposals" title="Proposals">
      {session ? (
        <div className="work-body">
          <div className="work-actions">
            <PixelButton onClick={() => load(session)}>Load Proposals</PixelButton>
          </div>
          <ul aria-label="Proposals">
            {proposals.map((proposal) => (
              <li key={proposal.id} className="work-note">
                <p className="whitespace-pre-wrap">{proposal.content}</p>
                <p className="break-all work-log">Hash: {proposal.hash}</p>
                <p>Verdict: {proposal.verdict.passed ? 'pass' : 'fail'}</p>
                <ul aria-label="Findings" className="work-log">
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
        <p>Sign in to see Proposals.</p>
      )}
    </WorkSection>
  )
}
