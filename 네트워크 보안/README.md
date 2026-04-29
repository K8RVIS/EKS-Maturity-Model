# 네트워크 보안 Task 정리 메모

이 디렉터리는 기존 `성숙도 모델 세부 사항.csv`의 `네트워크 보안` 항목을 EKS/Kubernetes 중심으로 다시 정리한 결과다.

## 정리 원칙

- EKS 또는 Kubernetes 운영과 직접 연결되는 항목만 남긴다.
- 항목명은 가능한 한 같은 추상화 레벨의 "보안 액션"으로 맞춘다.
- AWS 네트워크 일반 통제, 비용 최적화, 운영 편의성 중심 항목은 독립 Task에서 제외한다.
- 의미가 겹치는 항목은 삭제하지 않고 하나의 더 명확한 Task로 통합한다.

## 현재 포함된 항목

- [01-restrict-public-api-endpoint-cidr.md](./01-restrict-public-api-endpoint-cidr.md)
  - 원본 항목: `Public API Endpoint에 CIDR 제한`
- [02-enable-private-api-endpoint.md](./02-enable-private-api-endpoint.md)
  - 원본 항목: `Kubernetes API Server를 Private Endpoint 전환`
- [03-place-nodes-and-pods-in-private-subnets.md](./03-place-nodes-and-pods-in-private-subnets.md)
  - 원본 항목: `워커 노드, Pod Private Subnet 배치`
- [04-enable-eks-network-policy.md](./04-enable-eks-network-policy.md)
  - 원본 항목: `NetworkPolicy 설정` 중 "정책이 실제로 동작하도록 EKS 네트워크 정책 기능을 활성화한다"는 부분을 분리
- [05-apply-default-deny-networkpolicy.md](./05-apply-default-deny-networkpolicy.md)
  - 원본 항목: `NetworkPolicy 설정`, `Ingress, Egress 정책 분리`를 합쳐 "모든 namespace에 default-deny와 허용 목록 기반 정책을 적용한다"로 재구성
- [06-enforce-tls-on-ingress.md](./06-enforce-tls-on-ingress.md)
  - 원본 항목: `Ingress에 TLS 기본 적용`
- [07-restrict-coredns-and-dns-egress.md](./07-restrict-coredns-and-dns-egress.md)
  - 원본 항목: `CoreDNS 설정`을 DNS 보안 경계와 egress 제한 중심의 액션으로 재구성
- [08-enable-ebpf-network-threat-detection.md](./08-enable-ebpf-network-threat-detection.md)
  - 원본 항목: `eBPF 기반 네트워크 분석`을 이상 행위 탐지와 네트워크 가시성 중심의 액션으로 재구성
- [09-enforce-service-to-service-mtls.md](./09-enforce-service-to-service-mtls.md)
  - 원본 항목: `Service Mesh 도입`을 `서비스 간 mTLS 강제`라는 보안 액션 중심으로 재구성

## 상위 항목으로 묶어 표현한 항목

- 상위 항목: `NetworkPolicy 기반 네트워크 격리 적용`
  - 이유: 성숙도 모델 관점에서는 "클러스터 내 통신을 허용 목록 기반으로 격리한다"는 하나의 통제로 보는 편이 더 자연스럽다.
  - CSV 표현:
    - `NetworkPolicy 기반 네트워크 격리 적용 (상위 항목)`
    - `EKS NetworkPolicy 활성화 (하위 Task)`
    - `모든 namespace에 default-deny NetworkPolicy 적용 및 Ingress/Egress 정책 분리 (하위 Task)`
  - 연결 문서:
    - [04-enable-eks-network-policy.md](./04-enable-eks-network-policy.md)
    - [05-apply-default-deny-networkpolicy.md](./05-apply-default-deny-networkpolicy.md)

- `NetworkPolicy 설정`
  - 삭제가 아니라 상위 항목 아래 두 개의 실행 Task로 분해했다.
  - 이유: 원래 항목은 "기능 활성화"와 "정책 설계/적용"이 한 항목에 섞여 있어 실행 관점에서 경계가 불명확했다.
  - 반영 위치:
    - `04-enable-eks-network-policy.md`
    - `05-apply-default-deny-networkpolicy.md`

- `Ingress, Egress 정책 분리`
  - 별도 상위 항목으로 두지 않고 `05-apply-default-deny-networkpolicy.md`의 하위 범위로 흡수했다.
  - 이유: 이 항목은 독립 통제라기보다 default-deny 이후 허용 정책을 어떻게 나누는지에 대한 설계 원칙에 가깝다.

## 이번 정리에서 제외된 항목과 이유

- `VPC Endpoint를 인터넷 분리`
  - 이유: 중요한 통제이긴 하지만 현재 이름은 EKS보다는 AWS 네트워크 아키텍처 전반을 가리킨다.
  - 추가 설명: ECR, S3, STS, CloudWatch 경로를 VPC Endpoint로 전환하는 구체 액션으로 다시 정의하면 별도 Task로 재도입할 수 있다.

- `Security Group 최소 권한 부여`
  - 이유: 너무 넓은 표현이라 EKS Task 문서로 바로 쓰기 어렵다.
  - 추가 설명: EKS 노드 보안 그룹, Pod 보안 그룹, control plane 연동 보안 그룹처럼 대상을 좁혀야 같은 수준의 항목명이 된다.

- `WAF, Shield 적용`
  - 이유: EKS 클러스터 내부 네트워크 보안이라기보다 인터넷 공개 서비스의 엣지 보호 통제에 가깝다.
  - 추가 설명: 모든 EKS 워크로드에 공통 적용되는 항목이 아니라 외부 공개 서비스에만 선택적으로 적용되는 경우가 많다.

- `NAT Gateway 최소화`
  - 이유: 현재 표현은 보안보다는 비용 최적화와 egress 아키텍처 설계 성격이 더 강하다.
  - 추가 설명: 보안 Task로 만들려면 "노드 egress를 허용된 경로로 고정한다"처럼 통제 목적이 먼저 드러나야 한다.

- `NACL 설정`
  - 이유: 서브넷 단위의 거친 AWS 네트워크 통제로서, 현재 문서 세트에서는 EKS/Kubernetes 직접 통제보다 한 단계 아래 인프라 기본선에 가깝다.
  - 추가 설명: VPC 보안 기준 문서에는 들어갈 수 있지만, 이번 EKS Task 묶음에서는 우선순위를 낮췄다.

## 요약

- 남긴 항목은 EKS/Kubernetes에서 바로 실행 가능한 네트워크 보안 액션이다.
- 삭제된 항목 중 일부는 불필요해서가 아니라, 현재 이름이 너무 넓거나 AWS 일반 인프라 통제에 가까워 이번 묶음에서 제외했다.
- 나중에 재도입할 때는 `대상`, `통제 목적`, `검증 방법`이 드러나는 이름으로 다시 정의하는 것이 좋다.

## mTLS 분류 메모

- `mTLS`는 데이터 보호, 접근 제어, 네트워크 보안 성격을 모두 가진 교차 통제다.
- 이번 문서에서는 `서비스 간 트래픽 경로에서 상호 인증과 암호화를 강제한다`는 관점이 중심이므로 `네트워크 보안`에 배치했다.
- 반대로 인증서 수명주기와 키 관리가 중심이면 `데이터 보호`, 서비스 신원과 권한 검증이 중심이면 `접근 제어`로도 설명할 수 있다.
