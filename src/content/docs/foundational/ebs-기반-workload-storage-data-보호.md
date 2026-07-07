---
title: "EBS 기반 Workload Storage data를 보호한다"
description: "EKS에서 애플리케이션 데이터는 컨테이너 파일시스템에만 머무르지 않는다. Redis, PostgreSQL, 메시지 큐, 업로드 파일, 캐시 데이터처럼 지속성이 필요한 데이터는 `PersistentVolumeClaim(PVC)`을 통해 EBS, EFS 같은 외부 스토리지"
phase: "Foundational"
domain: "데이터 보호"
difficulty: "★☆☆"
owner: "남윤겸, 최은소"
order: 60
sidebar:
  order: 60
---

## 왜 필요한가

EKS에서 애플리케이션 데이터는 컨테이너 파일시스템에만 머무르지 않는다. Redis, PostgreSQL, 메시지 큐, 업로드 파일, 캐시 데이터처럼 지속성이 필요한 데이터는 `PersistentVolumeClaim(PVC)`을 통해 EBS, EFS 같은 외부 스토리지에 저장된다. 이때 스토리지 계층의 암호화가 빠지면 Pod 보안 설정이 잘 되어 있어도 실제 데이터가 저장되는 블록 볼륨이나 파일시스템에서 민감정보가 보호되지 않는다.

EBS 볼륨은 생성 시점의 암호화 설정이 중요하다. `StorageClass`가 `encrypted: "true"`를 명시하지 않거나 클러스터 기본 `StorageClass`에 의존하게 되면, AWS 계정/리전의 EBS 기본 암호화(`EBS encrypted by default`) 설정에 따라 결과가 달라질 수 있다. 특히 개발, 스테이징, 운영 계정이 나뉘어 있는 환경에서는 어떤 계정에서는 암호화되고 다른 계정에서는 비암호화 볼륨이 생기는 drift가 발생하기 쉽다.

또한 이미 생성된 EBS 볼륨은 StorageClass YAML파일을 수정하여도 자동으로 암호화되지 않는다. 비암호화 PV가 한 번 만들어지면 스냅샷 복사, 새 암호화 볼륨 생성, PVC 재바인딩 또는 데이터 마이그레이션이 필요하다. 따라서 워크로드 저장소는 처음부터 암호화 의도를 매니페스트에 명시하고, 실제 PV/EBS 볼륨 상태까지 검증해야 한다.

현재 `eks-vulnerable-infra`의 `db` StatefulSet은 Redis 데이터를 PVC로 저장하는 워크로드다. 이 저장소가 비암호화 StorageClass나 클러스터 기본 StorageClass에 의존하면 실제 Redis 데이터가 생성되는 EBS 볼륨의 암호화 상태를 매니페스트만 보고 보장하기 어렵다. 보완의 핵심은 기존 상태 저장 워크로드가 암호화된 EBS StorageClass를 명시적으로 사용하도록 바꾸는 것이다. PR의 핵심 적용 지점은 다음과 같다. 

- [`encrypted-gp3-storageclass.yaml`](https://github.com/K8RVIS/eks-secure-infra/blob/32ed2f8d152e20f17954b2985b6126426ed90f1e/manifests/base/storage/encrypted-gp3-storageclass.yaml#L1)은 `ebs.csi.aws.com` provisioner와 `parameters.encrypted: "true"`를 명시한다.
- [`statefulset.yaml`](https://github.com/K8RVIS/eks-secure-infra/blob/32ed2f8d152e20f17954b2985b6126426ed90f1e/manifests/base/db/statefulset.yaml#L56)은 Redis 데이터 PVC가 `storageClassName: encrypted-gp3`를 사용하도록 한다.
- [`check_ebs_encryption.py`](https://github.com/K8RVIS/eks-secure-infra/blob/32ed2f8d152e20f17954b2985b6126426ed90f1e/scripts/check_ebs_encryption.py#L1)는 매니페스트와 live 클러스터의 StorageClass, PVC, PV, EBS 볼륨 암호화 상태를 함께 점검한다.

이 항목의 목표는 다음 세 가지다.

- 기존 워크로드 PVC가 암호화된 EBS StorageClass를 명시적으로 사용하게 한다.
- AWS 계정/리전의 EBS 기본 암호화 상태를 확인하고, 매니페스트 설정과 함께 검증한다.
- 이미 생성된 PV/EBS 볼륨이 실제로 암호화되어 있는지 확인하고, 비암호화 볼륨은 마이그레이션 대상으로 분류한다.

## 수행 방법

**사전 조건**

- EKS 클러스터에 AWS EBS CSI Driver가 설치되어 있어야 한다.
- 대상 워크로드가 PVC 또는 `volumeClaimTemplates`를 사용하는지 확인할 수 있어야 한다.
- `kubectl`로 StorageClass, PVC, PV를 조회할 권한이 필요하다.
- AWS CLI로 `ec2:GetEbsEncryptionByDefault`, `ec2:DescribeVolumes`, 필요한 경우 KMS key 정보를 조회할 수 있어야 한다.
- GitOps 또는 Kustomize 기반 환경이라면 live 리소스를 직접 패치하기보다 원본 매니페스트를 우선 수정한다.

### Step 1: 기존 워크로드 저장소 사용 현황을 확인한다

먼저 기존 워크로드가 어떤 PVC를 사용하고, 어떤 StorageClass에 연결되어 있는지 확인한다.

```bash
kubectl get storageclass
kubectl get pvc -A
kubectl get pv
```

네임스페이스별 PVC와 StorageClass를 함께 보면 암호화 적용 범위를 빠르게 파악할 수 있다.

```bash
kubectl get pvc -A \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,STATUS:.status.phase,SC:.spec.storageClassName,VOLUME:.spec.volumeName,SIZE:.status.capacity.storage'
```

StatefulSet이 동적으로 PVC를 만드는 경우 `volumeClaimTemplates`도 확인한다.

```bash
kubectl get statefulset db -n <namespace> -o yaml \
  | rg -n 'volumeClaimTemplates|storageClassName|storage:'
```

미적용 또는 취약한 상태는 다음과 같다.

- PVC에 `storageClassName`이 없어 클러스터 기본 StorageClass에 의존한다.
- EBS StorageClass에 `parameters.encrypted: "true"`가 없다.
- AWS 계정/리전의 EBS 기본 암호화가 꺼져 있다.
- 이미 생성된 PV의 실제 EBS 볼륨이 `Encrypted: false`다.
- 민감 데이터를 저장하는 StatefulSet이 비암호화 또는 불명확한 StorageClass를 사용한다.

### Step 2: EBS 기본 암호화 상태를 확인한다

AWS 계정/리전 단위 EBS 기본 암호화(`EBS encrypted by default`)는 중요한 안전망이다. 하지만 매니페스트의 명시적 암호화 설정을 대체하는 것은 아니다. 이 단계에서는 기존 PVC가 생성될 때 AWS 계정 설정에만 의존하고 있지 않은지 확인한다.

```bash
aws ec2 get-ebs-encryption-by-default \
  --region <region> \
  --output json
```

기대 결과:

```json
{
  "EbsEncryptionByDefault": true
}
```

꺼져 있다면 비암호화 EBS가 생성될 수 있으므로 보안 기준에 따라 활성화한다.

```bash
aws ec2 enable-ebs-encryption-by-default \
  --region <region>
```

기본 KMS key도 확인한다.

```bash
aws ec2 get-ebs-default-kms-key-id \
  --region <region> \
  --output json
```

운영 환경에서는 AWS managed key `alias/aws/ebs`를 사용할지, customer managed KMS key를 사용할지 정책으로 정해야 한다. 감사, key rotation, key policy 분리, 계정 간 복구 요구사항이 있으면 customer managed key를 검토한다.

### Step 3: 암호화된 EBS StorageClass를 선언한다

EBS CSI Driver를 사용하는 StorageClass에는 암호화 의도를 명시한다. 이 StorageClass는 기존 상태 저장 워크로드가 사용할 표준 StorageClass로 관리한다.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: encrypted-gp3
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Delete
```

핵심은 `parameters.encrypted: "true"`다. 
<br>
`volumeBindingMode: WaitForFirstConsumer`는 Pod가 스케줄링될 노드의 가용 영역을 고려해 EBS 볼륨을 만들게 하므로, 멀티 AZ EKS 환경에서 PVC와 Pod의 AZ 불일치 문제를 줄인다.

customer managed KMS key를 사용한다면 StorageClass에 KMS key ID도 명시한다.

```yaml
parameters:
  type: gp3
  encrypted: "true"
  kmsKeyId: arn:aws:kms:<region>:111122223333:key/<key>
```

이 경우 EBS CSI Driver가 사용하는 IAM role에 해당 KMS key 사용 권한이 필요하다. 최소한 `kms:CreateGrant`, `kms:Encrypt`, `kms:Decrypt`, `kms:ReEncrypt*`, `kms:GenerateDataKey*`, `kms:DescribeKey` 권한을 key policy와 IAM policy 양쪽에서 검토한다.

### Step 4: 기존 StatefulSet이 암호화 StorageClass를 사용하게 한다

`db`처럼 PVC를 자동 생성하는 기존 StatefulSet은 `volumeClaimTemplates`에 암호화 StorageClass를 선언한다.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  volumeClaimTemplates:
    - metadata:
        name: redis-data
      spec:
        storageClassName: encrypted-gp3
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 1Gi
```

`db` StatefulSet도 이 방식으로 Redis 데이터 볼륨을 `encrypted-gp3`에 연결한다. 이 변경은 새로 생성되는 PVC와 EBS 볼륨에 적용된다. 기존 PVC/PV가 이미 존재한다면 새 StorageClass로 자동 변경되지 않으므로 별도 마이그레이션 계획이 필요하다.

### Step 5: 기본 StorageClass 의존을 줄인다

PVC에 `storageClassName`이 없으면 클러스터 기본 StorageClass가 사용된다. 기본 StorageClass가 암호화되어 있어도 저장소 보안 의도가 보이지 않기에 민감 데이터를 저장하는 PVC에는 명시적 StorageClass를 둔다.

```yaml
spec:
  storageClassName: encrypted-gp3
```

기본 StorageClass 자체도 암호화된 설정인지 점검한다.

```bash
kubectl get storageclass -o yaml \
  | rg -n 'name:|is-default-class|provisioner:|encrypted:|kmsKeyId:'
```

기본 StorageClass 변경은 새 PVC 생성 경로 전체에 영향을 주므로, 이 항목에서는 기존 취약 워크로드의 `storageClassName`을 명시적으로 보완하는 것을 우선한다. 기본 StorageClass 전환은 별도 변경으로 분리해 영향 범위를 검토한 뒤 적용한다.

### Step 6: 기존 비암호화 PV는 재생성 또는 마이그레이션한다

StorageClass를 수정해도 이미 생성된 EBS 볼륨은 암호화되지 않는다. 기존 PV가 비암호화라면 다음 중 하나로 전환한다.

1. 애플리케이션 중단이 가능한 경우 새 암호화 PVC를 만들고 데이터를 복사한다.
2. EBS snapshot을 생성한 뒤 암호화된 snapshot copy를 만들고 새 볼륨으로 복구한다.
3. 데이터베이스라면 replica, backup/restore, dump/load 같은 애플리케이션 수준 절차를 사용한다.
4. StatefulSet은 새 PVC 이름과 ordinal 영향, `Retain`/`Delete` reclaim policy, 복구 순서를 사전에 점검한다.

비암호화 볼륨을 찾는 명령은 다음과 같다.

```bash
kubectl get pv -o json \
  | jq -r '.items[] | [.metadata.name, .spec.storageClassName, (.spec.csi.volumeHandle // .spec.awsElasticBlockStore.volumeID // "-")] | @tsv'
```

찾은 EBS volume ID를 AWS에서 확인한다.

```bash
aws ec2 describe-volumes \
  --region <region> \
  --volume-ids <volume-id> \
  --query 'Volumes[].{VolumeId:VolumeId,Encrypted:Encrypted,KmsKeyId:KmsKeyId,State:State,Type:VolumeType}' \
  --output table
```

`Encrypted`가 `False`면 데이터 마이그레이션 대상으로 분류한다.

### Step 7: 점검 스크립트를 CI 또는 운영 점검에 포함한다

`scripts/check_ebs_encryption.py`는 기존 매니페스트와 live 리소스의 암호화 상태를 점검하기 위한 보조 도구로 아래의 항목을 함께 확인한다.

- AWS 리전의 EBS 기본 암호화 상태
- 매니페스트에 선언된 EBS StorageClass의 `encrypted` 파라미터
- PVC와 StatefulSet `volumeClaimTemplates`의 StorageClass 참조
- live 클러스터의 StorageClass, PVC, PV 상태
- PV가 연결한 실제 EBS volume의 `Encrypted` 값

매니페스트만 점검할 때:

```bash
python scripts/check_ebs_encryption.py \
  --repo-root . \
  --region <region>
```

클러스터와 실제 EBS 볼륨까지 함께 점검할 때:

```bash
python scripts/check_ebs_encryption.py \
  --repo-root . \
  --region <region> \
  --cluster \
  --namespace <namespace>
```

CI에서는 JSON 출력으로 결과를 수집할 수 있다.

```bash
python scripts/check_ebs_encryption.py \
  --repo-root . \
  --region <region> \
  --json
```

스크립트가 `HIGH`를 반환하는 경우는 실제 비암호화 위험이 높다는 뜻이므로 PR을 막거나 마이그레이션 이슈를 생성할 필요가 있다. `LOW`는 AWS 기본 암호화 안전망으로 보호될 수 있지만 매니페스트에 명시성이 부족한 상태로 본다. `MISS`는 자동 판단에 필요한 StorageClass 또는 EBS 정보가 부족하므로 사람이 직접 확인한다.

## 검증 방법

StorageClass에 암호화 설정이 명시되어 있는지 확인한다.

```bash
kubectl get storageclass encrypted-gp3 -o yaml
```

기대 결과:

- `provisioner: ebs.csi.aws.com`
- `parameters.type: gp3`
- `parameters.encrypted: "true"`
- 필요 시 `parameters.kmsKeyId`가 의도한 KMS key를 가리킨다.

PVC가 암호화 StorageClass를 참조하는지 확인한다.

```bash
kubectl get pvc -n <namespace> \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,SC:.spec.storageClassName,VOLUME:.spec.volumeName'
```

기대 결과는 민감 데이터를 저장하는 PVC의 `SC`가 `encrypted-gp3` 또는 조직에서 승인한 암호화 StorageClass인 것이다.

StatefulSet의 `volumeClaimTemplates`도 확인한다.

```bash
kubectl get statefulset db -n <namespace> -o yaml \
  | rg -n 'volumeClaimTemplates|storageClassName|encrypted-gp3'
```

기대 결과:

```yaml
storageClassName: encrypted-gp3
```

PV가 실제 EBS volume ID를 가지고 있는지 확인한다.

```bash
kubectl get pv <pv-name> -o jsonpath='{.spec.csi.volumeHandle}{"\n"}'
```

해당 EBS volume이 암호화되어 있는지 확인한다.

```bash
aws ec2 describe-volumes \
  --region <region> \
  --volume-ids <volume-id> \
  --query 'Volumes[].{VolumeId:VolumeId,Encrypted:Encrypted,KmsKeyId:KmsKeyId,Type:VolumeType,State:State}' \
  --output json
```

기대 결과:

- `Encrypted`가 `true`다.
- customer managed KMS key를 쓰는 경우 `KmsKeyId`가 승인된 key다.
- `Type`이 의도한 볼륨 타입이다. 예: `gp3`

매니페스트와 클러스터를 스크립트로 점검한다.

```bash
python scripts/check_ebs_encryption.py \
  --repo-root . \
  --region <region> \
  --cluster \
  --namespace <namespace>
```

기대 결과:

- `HIGH`가 0개다.
- 민감 워크로드 PVC가 `OK`로 분류된다.
- `MISS`가 있다면 StorageClass YAML 누락, live cluster 조회 권한 부족, region/profile 설정 누락 여부를 확인한다.

Kustomize 렌더링 결과에서도 암호화 StorageClass가 포함되는지 확인한다.

```bash
kubectl kustomize manifests/base \
  | rg -n 'kind: StorageClass|name: encrypted-gp3|encrypted: "true"|storageClassName: encrypted-gp3'
```

기대 결과는 StorageClass와 PVC/StatefulSet 참조가 같은 렌더링 결과에 함께 나타나는 것이다.

## Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 공격자가 탈취한 AWS 권한이나 잘못 노출된 스냅샷을 통해 EBS volume 또는 snapshot에 접근하고, 비암호화 저장 데이터에서 세션 정보, 캐시 데이터, 개인정보, 내부 토큰을 추출한다.
- **운영 리스크:** 계정별 EBS 기본 암호화 설정이 달라 dev에서는 암호화되지만 prod에서는 비암호화되는 식의 환경 drift가 생길 수 있다.
- **복구 리스크:** 비암호화 PV가 생성된 뒤에는 단순 YAML 수정으로 해결되지 않는다. 데이터 복사, 스냅샷 암호화 복사, 새 PVC 전환, 애플리케이션 재시작이 필요하다.
- **감사 리스크:** PVC가 기본 StorageClass에 의존하면 보안 점검에서 저장소 암호화 의도가 명확히 드러나지 않는다.
- **데이터 보호 실패:** 로그, 캐시, DB 파일, 업로드 파일, 세션 저장소가 저장 시 암호화되지 않아 스토리지 계층 침해 시 피해가 커진다.
- **심각도:** **높음**. 워크로드 스토리지는 실제 애플리케이션 데이터가 장기간 남는 계층이므로 암호화 누락은 데이터 유출과 복구 비용 증가로 이어질 수 있다.

## 발생 비용

- **기존 PV 마이그레이션 소요:** 이미 비암호화 볼륨이 있으면 애플리케이션 담당자와 함께 백업, 복구, 데이터 검증, 중단 시간 조율이 필요하다. 
- **AWS 비용 발생 여부 및 예상 규모:** EBS 암호화 자체에는 별도 추가 요금이 없다. 다만 EBS 볼륨, snapshot, snapshot copy, 데이터 전송, KMS API 호출 비용은 사용량에 따라 발생할 수 있다.
- **KMS 비용:** customer managed KMS key를 사용하면 key 월 비용과 API 호출 비용이 발생한다. AWS managed key를 사용하면 운영 부담은 낮지만 key policy 분리와 감사 요구사항 대응 범위가 제한될 수 있다.
- **운영 비용:** StorageClass 표준화, KMS key policy 관리, CSI Driver 권한 관리, PV 마이그레이션 절차 문서화가 필요하다.
- **대안 비용:** EFS, FSx, RDS 같은 관리형 스토리지 또는 데이터베이스를 사용할 경우 각 서비스의 암호화 설정과 비용 모델을 별도로 검토해야 한다.

## 참고 자료

- [Amazon EBS encryption](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-encryption.html)
- [Enable Amazon EBS encryption by default](https://docs.aws.amazon.com/ebs/latest/userguide/encryption-by-default.html)
- [Amazon EBS CSI Driver - StorageClass parameters](https://github.com/kubernetes-sigs/aws-ebs-csi-driver/blob/master/docs/parameters.md)
- [Kubernetes Storage Classes](https://kubernetes.io/docs/concepts/storage/storage-classes/)
- [Kubernetes Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- [EKS Best Practices Guide - Data encryption and secrets management](https://aws.github.io/aws-eks-best-practices/security/docs/data/)
- [AWS KMS key policies](https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html)

## 연계된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 연결된다.

- **[AWS Well-Architected Framework - Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html)**
  저장 데이터 보호, 암호화 key 관리, 보안 자동화와 연결된다.
- **[EKS Best Practices Guide - Security](https://aws.github.io/aws-eks-best-practices/security/)**
  Kubernetes Secret, persistent storage, AWS KMS, 데이터 암호화 원칙과 연결된다.
- **[CIS Controls v8](https://www.cisecurity.org/controls/v8)**
  `3.11 Encrypt Sensitive Data at Rest`
  민감 데이터를 저장할 때 강한 암호화를 적용하도록 요구한다.
- **[NIST SP 800-53 Rev.5](https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final)**
  `SC-28 Protection of Information at Rest`, `SC-12 Cryptographic Key Establishment and Management`, `SC-13 Cryptographic Protection`과 연결된다.
- **[Kubernetes Security Checklist](https://kubernetes.io/docs/concepts/security/security-checklist/)**
  워크로드가 사용하는 Secret, volume, storage resource의 접근 통제와 보호 상태를 점검하는 원칙과 연결된다.

## 적용 시 체크리스트

- [ ] AWS 계정/리전의 EBS 기본 암호화(`EBS encrypted by default`)가 활성화되어 있는가?
- [ ] EBS CSI Driver 기반 StorageClass에 `parameters.encrypted: "true"`가 명시되어 있는가?
- [ ] customer managed KMS key 사용 시 `kmsKeyId`와 EBS CSI Driver IAM/KMS 권한이 올바르게 구성되어 있는가?
- [ ] 민감 데이터를 저장하는 PVC가 `storageClassName`을 명시적으로 지정하는가?
- [ ] StatefulSet의 `volumeClaimTemplates`가 암호화된 StorageClass를 사용하고 있는가?
- [ ] PVC가 클러스터 기본 StorageClass에 암묵적으로 의존하지 않는가?
- [ ] 이미 생성된 PV가 연결한 실제 EBS volume의 `Encrypted` 값이 `true`인지 확인했는가?
- [ ] 비암호화 PV/EBS volume이 발견되면 재생성 또는 마이그레이션 계획이 있는가?
- [ ] Kustomize/Helm 렌더링 결과에 암호화 StorageClass와 PVC 참조가 함께 포함되는가?
- [ ] PR 또는 CI 단계에서 StorageClass/PVC 암호화 설정을 점검하는 스크립트가 실행되는가?
- [ ] 스냅샷, 백업, 복구 볼륨도 동일한 암호화 key 정책을 따르는가?

