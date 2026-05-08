# Kubernetes API endpoint를 private-only로 전환한다

> **Phase:** Foundational (기본 보안)
>
> **보안 영역:** 네트워크 보안
>
> **담당:** 공통 (전체 실습)
>
> **난이도:** ★★☆

---

## 왜 필요한가

EKS Kubernetes API Server는 `kubectl`, Terraform, GitOps 컨트롤러, 클러스터 애드온, 운영 자동화가 클러스터를 제어할 때 사용하는 관리 평면 진입점이다. IAM 인증과 Kubernetes RBAC가 적용되어 있더라도 API endpoint가 public으로 열려 있으면 인터넷 또는 허용된 public CIDR에서 API Server까지 네트워크 도달이 가능하다.

Public endpoint를 VPN egress IP `/32`로 제한하면 인터넷 전체 노출은 줄어든다. 하지만 이 방식은 여전히 다음 한계를 가진다.

- `endpointPublicAccess = true`인 동안 Kubernetes API Server의 public 접근면이 남는다.
- VPN egress IP를 공유하는 모든 주체가 API Server 인증면까지 도달할 수 있다.
- 운영 중 장애 대응, CI/CD 연결, 재택 IP 변경 등을 이유로 public CIDR 예외가 넓어질 수 있다.
- 탈취된 kubeconfig, 과도한 IAM 권한, 잘못된 `aws-auth` 또는 EKS access entry가 있으면 실제 공격 경로가 될 수 있다.

따라서 운영 클러스터나 민감 데이터를 다루는 환경에서는 public endpoint를 끄고, API Server 접근을 VPC 내부 또는 연결된 사설망으로 제한하는 것이 안전하다. 이 실습에서는 `eks-secure-infra`의 EKS API endpoint를 private-only로 전환하고, 별도 VPN VPC에서 private endpoint로 접근할 수 있도록 VPC Peering, 양방향 route, 보안 그룹 규칙을 함께 구성한다.

## 수행 방법

**사전 조건**

- EKS 클러스터와 VPC를 수정할 수 있는 IAM 권한이 필요하다.
  - 예: `eks:DescribeCluster`, `eks:UpdateClusterConfig`, `ec2:CreateVpcPeeringConnection`, `ec2:CreateRoute`, `ec2:AuthorizeSecurityGroupIngress`
- private endpoint에 접근할 운영 경로가 준비되어 있어야 한다.
  - VPN, VPC Peering, Transit Gateway, Direct Connect, Bastion, SSM Session Manager 등
- private endpoint DNS 해석을 위해 VPC DNS 설정이 켜져 있어야 한다.
  - `enableDnsSupport = true`
  - `enableDnsHostnames = true`
  - DHCP options에서 `AmazonProvidedDNS` 사용
- public endpoint를 끄기 전에, 운영자와 자동화 도구가 VPC 내부 또는 연결망에서 API Server에 접근할 수 있는지 검증해야 한다.

### **Step 1: 적용 전 public endpoint 노출 상태를 확인한다**

```bash
export AWS_PROFILE=eks-security-infra
export AWS_REGION=ap-northeast-2
export CLUSTER_NAME=eks-secure-infra-dev

aws eks describe-cluster \
  --region "${AWS_REGION}" \
  --name "${CLUSTER_NAME}" \
  --query 'cluster.resourcesVpcConfig' \
  --output json
```

적용 전 실습 환경은 다음과 같이 public endpoint와 private endpoint가 모두 켜져 있었다.

```json
{
  "endpointPublicAccess": true,
  "endpointPrivateAccess": true,
  "publicAccessCidrs": [
    "13.125.215.119/32"
  ]
}
```

VPN egress IP에서 public endpoint 도달 여부도 확인한다.

```bash
curl -s --connect-timeout 5 https://checkip.amazonaws.com

ENDPOINT=$(aws eks describe-cluster \
  --region "${AWS_REGION}" \
  --name "${CLUSTER_NAME}" \
  --query 'cluster.endpoint' \
  --output text)

curl -sk --connect-timeout 5 \
  -o /dev/null \
  -w '%{http_code} %{remote_ip}\n' \
  "${ENDPOINT}/readyz"
```

`200 <public-ip>`처럼 응답하면, 허용된 VPN egress IP에서 public API endpoint까지 네트워크 도달이 가능한 상태다.

### **Step 2: EKS API endpoint를 private-only로 전환한다**

Terraform EKS 모듈에서 public endpoint를 끄고 private endpoint만 남긴다.

```hcl
resource "aws_eks_cluster" "this" {
  name     = local.cluster_name
  role_arn = aws_iam_role.cluster.arn
  version  = var.kubernetes_version

  vpc_config {
    subnet_ids              = var.cluster_subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = false
  }
}
```

public endpoint를 사용하지 않으므로 `cluster_public_access_cidrs`, `public_access_cidrs` 입력도 제거한다. 이 값은 public endpoint가 켜져 있을 때만 의미가 있다.

### **Step 3: VPN VPC CIDR에서 EKS private endpoint TCP 443 접근을 허용한다**

EKS private endpoint는 EKS cluster security group의 ingress rule로 접근을 제어한다. VPN VPC CIDR에서 Kubernetes API Server HTTPS 포트로 들어오는 트래픽을 허용한다.

```hcl
variable "cluster_private_endpoint_access_cidrs" {
  description = "Private CIDR blocks allowed to access the EKS private API endpoint through the cluster security group."
  type        = list(string)
  default     = []
}

resource "aws_security_group_rule" "cluster_private_endpoint_ingress" {
  for_each = toset(var.cluster_private_endpoint_access_cidrs)

  type              = "ingress"
  security_group_id = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  protocol          = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_blocks       = [each.value]
  description       = "Allow private EKS API endpoint access from ${each.value}"
}
```

환경 입력값은 다음처럼 설정한다.

```hcl
cluster_private_endpoint_access_cidrs = [
  "172.31.0.0/16",
]
```

VPN EC2가 Tailscale exit node 또는 subnet router처럼 동작한다면, 트래픽이 `172.31.9.218` 또는 VPN VPC CIDR 내부 주소로 SNAT되어 EKS VPC에 들어와야 한다. source IP가 Tailscale overlay 대역(`100.64.0.0/10`)으로 유지되면 EKS cluster security group과 VPC Peering 경로에서 막힐 수 있다.

### **Step 4: EKS VPC와 VPN VPC를 VPC Peering으로 연결한다**

`eks-secure-infra`에서는 EKS VPC를 매번 삭제 후 재생성할 수 있으므로, peering과 route도 Terraform으로 함께 생성한다. 별도 `vpc-peering` 모듈을 만들어 requester는 EKS VPC, accepter는 기존 VPN VPC로 둔다.

```hcl
resource "aws_vpc_peering_connection" "this" {
  vpc_id      = var.requester_vpc_id
  peer_vpc_id = var.accepter_vpc_id
  auto_accept = true
}

resource "aws_vpc_peering_connection_options" "this" {
  vpc_peering_connection_id = aws_vpc_peering_connection.this.id

  requester {
    allow_remote_vpc_dns_resolution = true
  }

  accepter {
    allow_remote_vpc_dns_resolution = true
  }
}

resource "aws_route" "requester_to_accepter" {
  for_each = toset(var.requester_route_table_ids)

  route_table_id            = each.value
  destination_cidr_block    = var.accepter_vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.this.id
}

resource "aws_route" "accepter_to_requester" {
  for_each = toset(var.accepter_route_table_ids)

  route_table_id            = each.value
  destination_cidr_block    = var.requester_vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.this.id
}
```

infra 환경에서는 VPN VPC route table을 조회해 반대편 route를 자동으로 추가한다.

```hcl
data "aws_route_tables" "vpn" {
  vpc_id = var.vpn_vpc_id
}

module "vpn_peering" {
  source = "../../modules/vpc-peering"

  requester_vpc_id          = module.vpc.vpc_id
  requester_vpc_cidr        = module.vpc.vpc_cidr
  requester_route_table_ids = [module.vpc.private_route_table_id]

  accepter_vpc_id          = var.vpn_vpc_id
  accepter_vpc_cidr        = var.vpn_vpc_cidr
  accepter_route_table_ids = data.aws_route_tables.vpn.ids
}
```

환경 입력값은 다음과 같다.

```hcl
vpn_vpc_id   = "vpc-096c2102f9e82e7e2"
vpn_vpc_cidr = "172.31.0.0/16"
```

**Step 5: VPN EC2가 라우터로 동작할 수 있게 설정한다**

VPN EC2가 Tailscale exit node, subnet router, NAT instance처럼 클라이언트 패킷을 다른 VPC로 전달한다면 EC2의 source/destination check를 꺼야 한다.

```bash
aws ec2 modify-instance-attribute \
  --region "${AWS_REGION}" \
  --instance-id i-01a913dba273e1dd4 \
  --no-source-dest-check
```

상태를 확인한다.

```bash
aws ec2 describe-instances \
  --region "${AWS_REGION}" \
  --instance-ids i-01a913dba273e1dd4 \
  --query 'Reservations[].Instances[].{id:InstanceId,sourceDestCheck:SourceDestCheck,privateIp:PrivateIpAddress,publicIp:PublicIpAddress,state:State.Name}' \
  --output json
```

기대 결과:

```json
[
  {
    "id": "i-01a913dba273e1dd4",
    "sourceDestCheck": false,
    "privateIp": "172.31.9.218",
    "publicIp": "13.125.215.119",
    "state": "running"
  }
]
```

Tailscale을 subnet router로 명확하게 운영하려면 VPN EC2에서 EKS VPC CIDR을 advertise하고, Tailscale admin console에서 route를 승인한다.

```bash
sudo sysctl -w net.ipv4.ip_forward=1

sudo tailscale up \
  --advertise-exit-node \
  --advertise-routes=10.0.0.0/16 \
  --snat-subnet-routes=true
```

Mac 또는 운영자 단말에서는 다음처럼 route 수락 상태를 확인한다.

```bash
tailscale status --json \
  | jq '.Peer[] | select(.HostName=="ip-172-31-9-218") | .AllowedIPs'
```

## 검증 방법

### **1. Terraform 테스트를 실행한다**

```bash
terraform -chdir=modules/eks test
terraform -chdir=modules/vpc-peering test
terraform -chdir=modules/eks validate
terraform -chdir=modules/vpc-peering validate
terraform -chdir=environments/infra validate
```

기대 결과:

```text
Success! 1 passed, 0 failed.
Success! The configuration is valid.
```

### **2. Terraform plan으로 변경 내용을 확인한다**

```bash
AWS_PROFILE=eks-security-infra \
terraform -chdir=environments/infra plan -no-color
```

기대 변경:

```text
endpoint_public_access: true -> false

aws_security_group_rule.cluster_private_endpoint_ingress["172.31.0.0/16"]
  cidr_blocks = ["172.31.0.0/16"]
  protocol    = "tcp"
  from_port   = 443
  to_port     = 443

aws_vpc_peering_connection
  vpc_id      = <eks-vpc-id>
  peer_vpc_id = vpc-096c2102f9e82e7e2

aws_route requester_to_accepter
  destination_cidr_block = 172.31.0.0/16

aws_route accepter_to_requester
  destination_cidr_block = 10.0.0.0/16
```

### **3. EKS endpoint 설정을 확인한다**

```bash
aws eks describe-cluster \
  --region "${AWS_REGION}" \
  --name "${CLUSTER_NAME}" \
  --query '{
    endpoint: cluster.endpoint,
    endpointPublicAccess: cluster.resourcesVpcConfig.endpointPublicAccess,
    endpointPrivateAccess: cluster.resourcesVpcConfig.endpointPrivateAccess,
    publicAccessCidrs: cluster.resourcesVpcConfig.publicAccessCidrs,
    vpcId: cluster.resourcesVpcConfig.vpcId,
    clusterSecurityGroupId: cluster.resourcesVpcConfig.clusterSecurityGroupId
  }' \
  --output json
```

기대 결과:

```json
{
  "endpointPublicAccess": false,
  "endpointPrivateAccess": true
}
```

`endpointPublicAccess = false`이면 `publicAccessCidrs`에 과거 값이 남아 있어도 public endpoint 접근에는 사용되지 않는다. 판단 기준은 public endpoint 활성화 여부다.

### **4. VPC Peering과 route를 확인한다**

```bash
aws ec2 describe-vpc-peering-connections \
  --region "${AWS_REGION}" \
  --filters \
    Name=requester-vpc-info.vpc-id,Values=<eks-vpc-id> \
    Name=accepter-vpc-info.vpc-id,Values=vpc-096c2102f9e82e7e2 \
  --query 'VpcPeeringConnections[].{id:VpcPeeringConnectionId,status:Status.Code,requester:RequesterVpcInfo.VpcId,accepter:AccepterVpcInfo.VpcId,requesterDns:RequesterVpcInfo.PeeringOptions.AllowDnsResolutionFromRemoteVpc,accepterDns:AccepterVpcInfo.PeeringOptions.AllowDnsResolutionFromRemoteVpc}' \
  --output table
```

기대 결과:

```text
status = active
requesterDns = true
accepterDns = true
```

EKS VPC route table에 VPN CIDR route가 있는지 확인한다.

```bash
aws ec2 describe-route-tables \
  --region "${AWS_REGION}" \
  --filters Name=vpc-id,Values=<eks-vpc-id> \
  --query 'RouteTables[].Routes[?DestinationCidrBlock==`172.31.0.0/16`]' \
  --output table
```

VPN VPC route table에 EKS CIDR route가 있는지 확인한다.

```bash
aws ec2 describe-route-tables \
  --region "${AWS_REGION}" \
  --filters Name=vpc-id,Values=vpc-096c2102f9e82e7e2 \
  --query 'RouteTables[].Routes[?DestinationCidrBlock==`10.0.0.0/16`]' \
  --output table
```

**5. EKS cluster security group ingress를 확인한다**

```bash
CLUSTER_SG_ID=$(aws eks describe-cluster \
  --region "${AWS_REGION}" \
  --name "${CLUSTER_NAME}" \
  --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' \
  --output text)

aws ec2 describe-security-groups \
  --region "${AWS_REGION}" \
  --group-ids "${CLUSTER_SG_ID}" \
  --query 'SecurityGroups[].IpPermissions[?FromPort==`443` && ToPort==`443`]' \
  --output json
```

기대 결과:

```json
[
  [
    {
      "IpProtocol": "tcp",
      "FromPort": 443,
      "ToPort": 443,
      "IpRanges": [
        {
          "CidrIp": "172.31.0.0/16"
        }
      ]
    }
  ]
]
```

### **6. 운영자 단말에서 private endpoint DNS와 라우팅을 확인한다**

```bash
ENDPOINT_HOST=$(aws eks describe-cluster \
  --region "${AWS_REGION}" \
  --name "${CLUSTER_NAME}" \
  --query 'cluster.endpoint' \
  --output text \
  | sed 's#https://##')

dig +short "${ENDPOINT_HOST}"
```

기대 결과는 public IP가 아니라 EKS VPC 내부 IP다.

```text
10.0.20.112
10.0.10.239
```

운영자 단말에서 해당 IP로 가는 route가 VPN 인터페이스를 타는지 확인한다.

```bash
route -n get 10.0.10.239
```

Tailscale을 사용한 실습 환경에서는 `utun` 인터페이스로 나가는 것을 확인할 수 있다.

```text
interface: utun7
```

### **7. private endpoint 도달성을 확인한다**

```bash
ENDPOINT=$(aws eks describe-cluster \
  --region "${AWS_REGION}" \
  --name "${CLUSTER_NAME}" \
  --query 'cluster.endpoint' \
  --output text)

curl -sk --connect-timeout 5 \
  -o /dev/null \
  -w '%{http_code} %{remote_ip}\n' \
  "${ENDPOINT}/readyz"
```

기대 결과:

```text
200 10.0.10.239
```

이 결과는 Kubernetes API Server의 `/readyz`가 private IP를 통해 응답했다는 뜻이다. 즉 public endpoint가 아니라 VPN/peering/private endpoint 경로로 API Server에 도달한 것이다.

### **8. kubectl 인증 포함 검증을 수행한다**

```bash
aws eks update-kubeconfig \
  --region "${AWS_REGION}" \
  --name "${CLUSTER_NAME}" \
  --profile "${AWS_PROFILE}"

kubectl --request-timeout=10s get --raw=/readyz
kubectl --request-timeout=10s get nodes -o wide
```

`curl /readyz`는 성공하지만 `kubectl`이 `Unauthorized`를 반환하면 네트워크는 성공이고 IAM/RBAC 매핑 문제다. 이 경우 `aws-auth` ConfigMap 또는 EKS access entry를 별도로 점검한다.

## Risk 및 미적용 시 영향

- **공격 시나리오:** public endpoint가 켜진 상태에서 VPN egress IP 또는 허용 CIDR 내부 계정이 탈취되면 공격자가 Kubernetes API Server까지 네트워크 도달 후 인증 시도를 반복할 수 있다.
- **취약한 자격 증명 악용:** 노출된 kubeconfig, 과도한 IAM 권한, 잘못된 `aws-auth` 매핑이 있으면 public endpoint를 통해 실제 클러스터 제어로 이어질 수 있다.
- **운영 실수 확대:** 장애 대응 중 public CIDR을 넓게 열고 되돌리지 않으면 인터넷 노출면이 장기간 유지될 수 있다.
- **영향 범위:** 클러스터 관리 평면 접근, 워크로드 조회/변경, Secret 조회, 악성 워크로드 배포, 서비스 중단
- **심각도:** **높음** — Kubernetes API Server는 클러스터 전체 권한으로 이어질 수 있는 핵심 관리 평면이다.

private-only 전환에도 운영 리스크가 있다.

- VPN, peering, route, DNS, security group 중 하나라도 누락되면 운영자가 클러스터에 접근하지 못한다.
- GitOps/CI 도구가 public endpoint에 의존하고 있었다면 배포 파이프라인이 중단될 수 있다.
- VPC를 삭제 후 재생성하는 실습 환경에서는 peering과 route도 함께 재생성되도록 IaC에 포함해야 한다.

## 인적 리소스 및 비용

- AWS 추가 비용: VPC Peering 자체는 시간당 비용이 없지만, AZ 간/리전 간 데이터 전송 비용이 발생할 수 있다.
- 운영 비용: VPN EC2 또는 exit node 운영 비용이 발생한다. 기존 VPN EC2를 사용하면 추가 인스턴스 비용은 없다.
- 도구 비용:  Terraform, kubectl은 별도 도구 비용 없음.

## 참고 자료

- [Amazon EKS Cluster API server endpoint](https://docs.aws.amazon.com/eks/latest/userguide/cluster-endpoint.html)
- [Amazon EKS cluster access with eksctl](https://docs.aws.amazon.com/eks/latest/eksctl/vpc-cluster-access.html)
- [Amazon VPC Peering Guide](https://docs.aws.amazon.com/vpc/latest/peering/what-is-vpc-peering.html)
- [Amazon VPC route tables](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Route_Tables.html)
- [Tailscale subnet routers](https://tailscale.com/kb/1019/subnets)
- [Tailscale exit nodes](https://tailscale.com/kb/1103/exit-nodes)

## Assessment 체크리스트

- [ ] EKS cluster의 `endpointPublicAccess`가 `false`인가?
- [ ] EKS cluster의 `endpointPrivateAccess`가 `true`인가?
- [ ] EKS endpoint DNS가 운영자 VPN 경로에서 `10.0.0.0/16` 내부 IP로 해석되는가?
- [ ] EKS cluster security group이 VPN VPC CIDR `172.31.0.0/16`에서 TCP 443 접근을 허용하는가?
- [ ] EKS VPC와 VPN VPC의 VPC Peering 상태가 `active`인가?
- [ ] EKS VPC route table에 `172.31.0.0/16 -> pcx-*` route가 있는가?
- [ ] VPN VPC route table에 `10.0.0.0/16 -> pcx-*` route가 있는가?
- [ ] VPN EC2가 라우터/exit node로 동작할 경우 source/destination check가 꺼져 있는가?
- [ ] VPN 내부 또는 연결망에서 `curl "${ENDPOINT}/readyz"`가 private IP로 `200`을 반환하는가?
- [ ] VPN 외부 또는 연결망 밖에서는 Kubernetes API endpoint 접근이 실패하는가?
- [ ] `kubectl get nodes` 또는 `kubectl get --raw=/readyz`가 내부 경로에서 정상 동작하는가?
