-- Outbound motor, phase F6 (playbook-v6, spec §4.43.10): the Signal Engine can
-- propose retiring a name fragment. Proposal only — an Owner approves it.

-- AlterEnum
ALTER TYPE "ProposalKind" ADD VALUE 'FRAGMENT_RETIREMENT';
