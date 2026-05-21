# EKS Maturity Advisor v1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add read-only live cluster scanning for the approved v1.1 Foundational controls and improve scanner severity/priority output.

**Architecture:** Keep the existing scanner entry point, add an injectable command runner, and layer live Foundational checks beside repo-only Quick Wins checks. Findings share one builder so domain, severity, priority, and sort order stay consistent.

**Tech Stack:** Node.js ESM, `node:test`, `js-yaml`, `kubectl` and AWS CLI command output parsed as JSON.

---

### Task 1: Finding Metadata And Priority

**Files:**
- Modify: `skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs`
- Test: `tests/skill-advisor.test.mjs`

- [ ] Add tests that assert findings include `domain` and `priority`.
- [ ] Add a shared item metadata map for existing Quick Wins and v1.1 Foundational items.
- [ ] Derive priority from `status` and `severity`.
- [ ] Sort findings before returning and before Markdown rendering.

### Task 2: Live Scan Runner

**Files:**
- Modify: `skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs`
- Test: `tests/skill-advisor.test.mjs`

- [ ] Add tests for `scanLiveCluster({ commandRunner })` using mocked command output.
- [ ] Implement a default runner with `child_process.execFileSync`.
- [ ] Parse `--live`, `--context`, `--cluster-name`, `--region`, and optional `--profile`.
- [ ] Return `unknown` findings rather than throwing when required live inputs are absent.

### Task 3: Foundational Live Checks

**Files:**
- Modify: `skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs`
- Test: `tests/skill-advisor.test.mjs`

- [ ] Implement `private-api-endpoint` from `aws eks describe-cluster`.
- [ ] Implement `private-subnets` from EKS nodegroups and EC2 subnet metadata.
- [ ] Implement `default-deny-networkpolicy` from live NetworkPolicy and Pod JSON.
- [ ] Implement `pod-실행-권한-최소화` from namespace labels and workload JSON.
- [ ] Implement `iam-k8s-mapping` from EKS access config and access entries.

### Task 4: Skill Documentation

**Files:**
- Modify: `skills/eks-maturity-advisor/SKILL.md`
- Modify: `skills/eks-maturity-advisor/references/quick-wins-v1.md`
- Modify: `plan.md`

- [ ] Update docs from v1 wording to v1.1 live scan wording.
- [ ] Document read-only command boundaries.
- [ ] Move deferred Foundational items to v1.2 notes.

### Task 5: Verification And Commit

**Files:**
- Validate all changed files.

- [ ] Run `npm test`.
- [ ] Run `npm run check`.
- [ ] Run `npm run build`.
- [ ] Run `npm run skill:catalog`.
- [ ] Confirm `template.md` remains untracked and excluded.
- [ ] Commit the v1.1 changes.

