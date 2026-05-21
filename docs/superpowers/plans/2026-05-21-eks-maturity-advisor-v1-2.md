# EKS Maturity Advisor v1.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish live read-only Foundational automation and release it as `eks-maturity-advisor-v1.2.0`.

**Architecture:** Extend the existing scanner with five additional live check functions and a kubeconfig auto-detection helper. Keep all live command execution behind the injectable command runner so CI does not need a cluster.

**Tech Stack:** Node.js ESM, `node:test`, `kubectl`, AWS CLI, mocked command runner fixtures.

---

### Task 1: Tests

**Files:**
- Modify: `tests/skill-advisor.test.mjs`

- [x] Add mocked live command outputs for Inspector, Grafana, EBS, ExternalSecrets, and RBAC.
- [x] Assert live scan returns all 10 Foundational findings.
- [x] Assert auto-detect reads kubeconfig and passes detected AWS profile to AWS commands.
- [x] Assert missing live inputs remain `unknown` without querying the current context.

### Task 2: Scanner

**Files:**
- Modify: `skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs`

- [x] Add metadata for the remaining Foundational items.
- [x] Implement `detectLiveConfig`.
- [x] Implement read-only checks for Inspector triage, Grafana, EBS storage protection, workload secret removal, and RBAC.
- [x] Add `--auto-detect` CLI parsing.

### Task 3: Documentation

**Files:**
- Modify: `skills/eks-maturity-advisor/SKILL.md`
- Modify: `skills/eks-maturity-advisor/references/quick-wins-v1.md`
- Modify: `plan.md`

- [x] Document all 10 live Foundational checks.
- [x] Document `--auto-detect`.
- [x] Record that real live verification needs a reachable cluster and refreshed AWS SSO.

### Task 4: Release

**Files:**
- Validate all changed files.

- [x] Run `npm run skill:catalog`.
- [x] Run `npm test`.
- [x] Run `npm run check`.
- [x] Run `npm run build`.
- [x] Run live auto-detect smoke and record whether credentials/cluster access are available.
- [ ] Commit, push main, tag `eks-maturity-advisor-v1.2.0`, and verify the GitHub Release asset.
