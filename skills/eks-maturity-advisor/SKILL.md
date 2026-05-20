---
name: eks-maturity-advisor
description: Assess Amazon EKS repositories and Kubernetes manifests against the EKS Maturity Model Quick Wins and Foundational controls. Use when Codex is asked to review EKS security posture, scan Kubernetes YAML or Terraform-backed EKS repos, prioritize Quick Wins gaps, explain maturity findings, or produce remediation and verification guidance without applying changes.
---

# EKS Maturity Advisor

## Safety Boundary

Operate read-only by default. Do not run `kubectl apply`, `terraform apply`, `helm upgrade`, `aws eks update-*`, or any command that mutates a cluster, AWS account, or repository unless the user explicitly asks for implementation after reviewing findings.

For v1, automated scanning is repo-only and covers five Quick Wins controls. Treat live cluster checks and full Foundational automation as v1.1 guidance unless the user provides command output to analyze.

## Workflow

1. Identify the input type:
   - Repository path or manifests: run or read `scripts/scan_eks_maturity.mjs`.
   - Scanner JSON: interpret the findings directly.
   - User-pasted YAML: assess it against the same Quick Wins rules.
   - Conceptual question: answer from `references/quick-wins-v1.md` and `references/catalog.json` when present.
2. Present findings in this order:
   - Critical Quick Wins failures first.
   - Warnings or unknowns next.
   - Passed controls last, briefly.
3. For each failed or unknown item, include:
   - maturity item id, phase, and domain
   - evidence from the repo or user input
   - risk in plain language
   - recommended remediation
   - read-only verification command
4. When the user asks for implementation, propose file-level changes first. Keep mutation out of the diagnostic answer.

## Tools

Generate a catalog from the source docs:

```bash
node skills/eks-maturity-advisor/scripts/generate_catalog.mjs \
  --output skills/eks-maturity-advisor/references/catalog.json
```

Scan a repository:

```bash
node skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs \
  --repo-root . \
  --output markdown
```

The scanner returns findings with:

```text
item_id, phase, status, severity, evidence, recommendation, verify_commands
```

## Interpretation Rules

- `fail`: concrete insecure or missing configuration was found.
- `warn`: use only when evidence is mixed or the control is partially met.
- `unknown`: the repo does not contain enough information to decide.
- `pass`: the checked manifests satisfy the v1 static rule; do not imply complete production assurance.

Prefer saying what is observable over overstating certainty. For example, “No Ingress manifest was found, so TLS cannot be assessed from this repo” is better than “TLS is not configured.”

## References

- `references/quick-wins-v1.md`: v1 scanner controls, limitations, and remediation notes.
- `references/catalog.json`: generated source catalog from Quick Wins and Foundational docs. Regenerate it from the repo docs instead of editing by hand.
