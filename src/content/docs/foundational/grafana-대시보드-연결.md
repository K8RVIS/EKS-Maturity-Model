---
title: "Grafana로 클러스터 메트릭을 시각화한다"
description: "**Prometheus 메트릭 수집 기반 구성** 단계에서 Prometheus가 메트릭을 수집하더라도, 숫자로만 나열된 시계열 데이터는 사람이 빠르게 판단하기 어렵다. 보안 이상 징후는 수치의 변화 패턴에서 드러나는 경우가 많다. API 서버 4xx 오류가 갑자기 급증"
phase: "Foundational"
domain: "Pod 보안"
order: 90
sidebar:
  order: 90
---

## 왜 필요한가

**Prometheus 메트릭 수집 기반 구성** 단계에서 Prometheus가 메트릭을 수집하더라도, 숫자로만 나열된 시계열 데이터는 사람이 빠르게 판단하기 어렵다. 보안 이상 징후는 수치의 변화 패턴에서 드러나는 경우가 많다. API 서버 4xx 오류가 갑자기 급증하거나, 특정 네임스페이스의 Pod가 짧은 시간에 반복 재시작하거나, ResourceQuota가 90%에 근접하는 상황은 그래프로 시각화할 때 즉시 인식된다.

Grafana는 Prometheus가 수집한 메트릭을 대시보드 형태로 렌더링해 운영자가 클러스터 상태를 한눈에 파악할 수 있게 한다.

- **직관적 이상 탐지:** 수치 변화를 그래프·게이지로 표현해 이상 패턴을 즉시 인식한다.
- **지속적 가시성:** 대시보드는 항상 열려 있는 상태로 클러스터 상태를 실시간 반영한다.
- **팀 공유:** URL 하나로 모든 팀원이 동일한 데이터를 본다.

이 단계는 Grafana 연결 자체에 집중한다. 의미 있는 보안 쿼리와 대시보드 구성은 **보안 메트릭 대시보드 구성** 단계에서 추가한다.

---

## 수행 방법

**사전 조건**

- **Prometheus 메트릭 수집 기반 구성** 단계가 배포되어 있어야 한다.
- Nginx Ingress Controller가 클러스터에 설치되어 있어야 한다.
- `/etc/hosts` 또는 내부 DNS에 `grafana.<cluster_name>.local` 등록이 가능해야 한다.
- `grafana_admin_password`를 환경변수로 주입할 수 있어야 한다.

### Step 1: 현황을 파악한다

Grafana가 이미 배포되어 있는지 확인한다.

```bash
kubectl get pods -n monitoring -l app.kubernetes.io/name=grafana
kubectl get svc -n monitoring | grep grafana
kubectl get ingress -n monitoring
```

### Step 2: Grafana를 활성화하고 Ingress를 구성한다

`modules/k8s-base/main.tf`의 kube-prometheus-stack Helm 릴리스에 Grafana 설정을 추가한다.

```hcl
resource "helm_release" "kube_prometheus_stack" {
  name             = "kube-prometheus-stack"
  repository       = "https://prometheus-community.github.io/helm-charts"
  chart            = "kube-prometheus-stack"
  version          = var.prometheus_chart_version
  namespace        = var.prometheus_namespace
  create_namespace = true

  values = [yamlencode({
    grafana = {
      enabled        = true
      adminPassword  = var.grafana_admin_password

      persistence = {
        enabled          = true
        storageClassName = "gp3-encrypted"
        size             = "5Gi"
      }

      sidecar = {
        dashboards = {
          enabled = true
          label   = "grafana_dashboard"
        }
      }

      ingress = {
        enabled          = true
        ingressClassName = "nginx"
        hosts            = ["grafana.${var.cluster_name}.local"]
      }
    }

    alertmanager = {
      enabled = false
    }

    prometheus = {
      prometheusSpec = {
        retention = "7d"

        resources = {
          requests = { cpu = "250m", memory = "512Mi" }
          limits   = { cpu = "500m", memory = "1Gi" }
        }

        storageSpec = {
          volumeClaimTemplate = {
            spec = {
              storageClassName = "gp3-encrypted"
              accessModes      = ["ReadWriteOnce"]
              resources = {
                requests = { storage = "20Gi" }
              }
            }
          }
        }
      }
    }

    kube-state-metrics = { enabled = true }
    nodeExporter        = { enabled = true }
  })]
}
```

`modules/k8s-base/variables.tf`에 변수를 추가한다.

```hcl
variable "grafana_admin_password" {
  description = "Grafana 관리자 비밀번호. 환경변수 TF_VAR_grafana_admin_password로 주입한다."
  type        = string
  sensitive   = true
}
```

### Step 3: 비밀번호를 환경변수로 주입하고 적용한다

Grafana 관리자 비밀번호는 코드에 직접 넣지 않고 환경변수로 주입한다.

```bash
export TF_VAR_grafana_admin_password="<strong-password>"
terraform plan
terraform apply
```

---

## 검증 방법

Grafana Pod와 서비스가 정상 기동하는지 확인한다.

```bash
kubectl get pods -n monitoring -l app.kubernetes.io/name=grafana
kubectl get svc -n monitoring | grep grafana
```

기대 결과: Grafana Pod가 `Running` 상태이고 서비스가 생성되어 있다.

PVC가 암호화된 GP3 스토리지를 사용하는지 확인한다.

```bash
kubectl get pvc -n monitoring | grep grafana
kubectl describe pvc -n monitoring | grep -A5 grafana
```

기대 결과: `StorageClass`가 `gp3-encrypted`, 상태가 `Bound`다.

Ingress가 정상 생성되었는지 확인한다.

```bash
kubectl get ingress -n monitoring
```

포트포워딩으로 Grafana UI 접근을 확인한다.

```bash
kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80
```

브라우저에서 `http://localhost:3000`을 열고 설정한 관리자 계정으로 로그인한다.

Grafana에서 Prometheus 데이터소스가 연결되어 있는지 확인한다.

```
Grafana UI → Configuration → Data Sources → Prometheus → Test
```

기대 결과: `Data source is working` 메시지가 표시된다.

**검증 완료 기준**

- Grafana Pod가 `Running` 상태이고 PVC가 `Bound`(gp3-encrypted)다.
- Grafana UI에 관리자 계정으로 로그인할 수 있다.
- Prometheus 데이터소스가 정상 연결(`Data source is working`)되어 있다.
- Ingress가 생성되어 있다.

---

## Risk 및 미적용 시 영향

- **가시성 부재:** Prometheus가 수집하는 메트릭이 활용되지 않는다. 이상 징후를 텍스트 쿼리로 수동 확인해야 하며, 탐지 반응 시간이 늘어난다.
- **비밀번호 평문 노출:** `grafana_admin_password`를 코드에 하드코딩하면 Git 히스토리에 노출된다. 반드시 환경변수 또는 Secrets Manager로 주입해야 한다.
- **스토리지 미암호화:** 암호화되지 않은 PVC를 사용하면 Grafana 세션 데이터, 알림 설정, 대시보드 구성이 평문으로 저장된다.
- **심각도:** **낮음**. 이 단계 자체가 공격을 막지는 않지만, 시각화 없이 운영하면 이상 탐지 반응 속도가 저하된다.

---

## 발생 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 공통 실습 또는 플랫폼/DevSecOps 담당자 |
| AWS 추가 비용 | Grafana PVC용 EBS GP3 스토리지 비용 발생 (5Gi 기준 약 월 $0.5) |
| 도구 비용 | Grafana OSS는 무료. 엔터프라이즈 기능이 필요하면 Grafana Cloud 또는 Amazon Managed Grafana 검토 |
| 운영 고려사항 | 관리자 비밀번호를 환경변수로 주입하면 CI/CD 파이프라인에서 Secrets 관리가 필요하다. AWS Secrets Manager 또는 SSM Parameter Store 연동을 검토한다. |

---

## 참고 자료

- [Grafana - Getting started](https://grafana.com/docs/grafana/latest/getting-started/)
- [kube-prometheus-stack - Grafana configuration](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack#grafana)
- [Grafana - Provisioning dashboards via Sidecar](https://grafana.com/docs/grafana/latest/administration/provisioning/#dashboards)
- [CIS Kubernetes Benchmark v1.12.0](https://www.cisecurity.org/benchmark/kubernetes)
- [NSA/CISA Kubernetes Hardening Guidance](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF)
- [AWS EKS Best Practices - Detecting security issues](https://docs.aws.amazon.com/eks/latest/best-practices/detective.html)

---

## 연계된 보안 가이드라인 항목

- **CIS Kubernetes Benchmark v1.12.0**
  클러스터 활동의 중앙 집중식 모니터링을 활성화하고 이상 탐지를 위한 시각화 체계를 갖출 것을 권고한다. Grafana 대시보드는 이 요건의 시각화 레이어를 담당한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  클러스터 내 비정상 활동 탐지를 위해 중앙 모니터링 체계를 구축하도록 권고한다. Grafana는 수집된 메트릭을 운영자가 실시간으로 확인할 수 있는 단일 창구 역할을 한다.
- **AWS EKS Best Practices**
  Amazon Managed Grafana 또는 자체 Grafana를 통해 클러스터 메트릭을 시각화하고 이상 탐지 대시보드를 운영하도록 권장한다.


## 적용 시 체크리스트

- [ ] Grafana Pod가 `Running` 상태인가?
- [ ] Grafana PVC가 `Bound`(gp3-encrypted)인가?
- [ ] Grafana UI 로그인이 가능한가?
- [ ] Prometheus 데이터소스가 정상 연결(`Data source is working`)되어 있는가?
- [ ] `grafana_admin_password`가 코드에 하드코딩되지 않고 환경변수로 주입되는가?

---
