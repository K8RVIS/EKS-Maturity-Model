# Ingress와 Load Balancer에서 TLS를 강제한다

> **Phase:** Quick Wins
>
> **보안 영역:** 네트워크 보안
>
> **담당:** 공통 (전체 실습)
>
> **난이도:** ★☆☆

---

#### 왜 필요한가

외부 사용자와 EKS 클러스터 경계 사이의 트래픽은 가장 먼저 암호화해야 하는 구간이다. Ingress나 Load Balancer가 HTTP만 허용하면 로그인 정보, 세션 쿠키, API 토큰, 개인정보가 네트워크 구간에서 평문으로 노출될 수 있고, 중간자 공격을 통해 요청과 응답이 변조될 수 있다.

TLS 적용은 단순히 브라우저 자물쇠 표시를 얻기 위한 작업이 아니다. 인증서 발급, 갱신, TLS 정책, HTTP to HTTPS 리다이렉트까지 표준화해야 서비스 신뢰성과 운영 예측 가능성이 함께 올라간다. 특히 EKS에서는 Ingress Controller, AWS Load Balancer Controller, Service type `LoadBalancer`, 외부 DNS, ACM 인증서가 함께 얽히므로 팀마다 다른 방식으로 설정하면 인증서 만료, 약한 TLS 정책, HTTP 예외 경로가 쉽게 생긴다.

현재 `eks-secure-infra` 실습 환경의 [ingress.yaml](/Users/esc/Desktop/K8RVIS/eks-secure-infra/manifests/base/web/ingress.yaml:1)은 `nginx` Ingress를 통해 `web` 서비스를 80 포트로 노출하지만 TLS 설정이 없다.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
spec:
  ingressClassName: nginx
  rules:
    - host: team-placeholder.training.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
```

이 상태는 실습 출발점으로는 적절하지만, 운영 기준에서는 외부 진입점에서 HTTPS를 강제하는 구조로 바꿔야 한다.

#### 수행 방법

**사전 조건**

- 공개할 도메인과 DNS 레코드 관리 권한이 있어야 한다.
- AWS Load Balancer Controller를 사용하는 경우 컨트롤러 설치와 IngressClass 구성이 완료되어 있어야 한다.
- ACM 인증서를 발급하거나 가져올 수 있는 IAM 권한이 있어야 한다. 예: `acm:RequestCertificate`, `acm:DescribeCertificate`, `acm:ImportCertificate`
- ALB 또는 NLB를 수정할 수 있는 권한이 있어야 한다. 예: `elasticloadbalancing:*Listener*`, `elasticloadbalancing:DescribeLoadBalancers`
- 인증서와 Load Balancer는 같은 리전에 있어야 한다. CloudFront에 붙이는 ACM 인증서와 ALB에 붙이는 ACM 인증서는 리전 요구사항이 다르므로 혼동하지 않는다.

**Step 1: 현재 Ingress와 Load Balancer 노출 상태를 확인한다**

먼저 어떤 Ingress가 HTTP만 사용하고 있는지 확인한다.

```bash
kubectl get ingress -A
kubectl describe ingress web -n team-d
```

TLS가 적용되지 않은 Ingress는 보통 `spec.tls`가 없거나, AWS Load Balancer Controller 사용 시 `certificate-arn`, `listen-ports`, `ssl-redirect` 같은 애너테이션이 없다.

AWS Load Balancer 리스너도 함께 확인한다.

```bash
aws elbv2 describe-load-balancers \
  --region ap-northeast-2 \
  --query 'LoadBalancers[].{Name:LoadBalancerName,DNSName:DNSName,Type:Type,Scheme:Scheme}' \
  --output table

aws elbv2 describe-listeners \
  --region ap-northeast-2 \
  --load-balancer-arn "${LOAD_BALANCER_ARN}" \
  --query 'Listeners[].{Port:Port,Protocol:Protocol,SslPolicy:SslPolicy,Certificates:Certificates[].CertificateArn}' \
  --output table
```

미적용 또는 취약한 상태는 다음과 같다.

- 80/HTTP 리스너만 있고 443/HTTPS 리스너가 없다.
- 80/HTTP 요청이 애플리케이션으로 그대로 전달된다.
- HTTPS 리스너는 있지만 인증서가 만료되었거나 도메인과 일치하지 않는다.
- `ELBSecurityPolicy-2016-08`처럼 TLS 1.0/1.1을 허용하는 오래된 정책을 사용한다.

**Step 2: ACM 인증서를 준비한다**

도메인을 소유하고 있다면 ACM에서 DNS 검증 방식으로 인증서를 발급한다.

```bash
export DOMAIN_NAME=team-d.example.com
export AWS_REGION=ap-northeast-2

aws acm request-certificate \
  --region "${AWS_REGION}" \
  --domain-name "${DOMAIN_NAME}" \
  --validation-method DNS \
  --idempotency-token teamdtls001
```

ACM이 반환한 DNS 검증 레코드를 Route 53 또는 외부 DNS에 등록한 뒤 발급 상태를 확인한다.

```bash
aws acm list-certificates \
  --region "${AWS_REGION}" \
  --certificate-statuses ISSUED \
  --query 'CertificateSummaryList[].{Domain:DomainName,Arn:CertificateArn}' \
  --output table
```

이미 외부 CA에서 발급한 인증서를 사용해야 한다면 ACM으로 가져온다.

```bash
aws acm import-certificate \
  --region "${AWS_REGION}" \
  --certificate fileb://certificate.pem \
  --private-key fileb://private-key.pem \
  --certificate-chain fileb://certificate-chain.pem
```

운영 환경에서는 인증서 ARN을 Kubernetes 매니페스트에 직접 반복해서 쓰기보다 Kustomize patch, Helm values, Terraform output, External Secrets 등 환경별 설정 경로로 관리한다.

**Step 3: TLS 종료 위치를 결정한다**

외부 진입점에서 TLS를 강제하되, 종료 위치는 서비스 요구사항에 따라 선택한다.

| 방식 | 설명 | 권장 상황 | 주의할 점 |
| --- | --- | --- | --- |
| ALB에서 TLS 종료 | ALB가 HTTPS를 받고 Pod로는 HTTP 전달 | 일반적인 웹/API 워크로드 | ALB 이후 내부 구간은 별도 암호화되지 않는다. |
| ALB에서 TLS 종료 후 백엔드 HTTPS 재암호화 | ALB가 HTTPS를 받고 대상 그룹도 HTTPS로 전달 | 내부 구간 암호화 요구가 있는 서비스 | Pod 또는 Ingress Controller 쪽 인증서와 health check 설정이 필요하다. |
| Ingress Controller에서 TLS 종료 | NLB 또는 외부 LB 뒤 nginx/Envoy가 TLS 종료 | nginx Ingress, Gateway API, service mesh와 결합할 때 | Kubernetes TLS Secret 관리와 갱신 자동화가 필요하다. |
| TLS passthrough | LB가 TLS를 열지 않고 백엔드로 전달 | 애플리케이션이 직접 TLS/mTLS를 처리해야 할 때 | L7 라우팅, 인증, 리다이렉트 기능이 제한될 수 있다. |

본 실습의 Quick Wins 기준은 외부 사용자 트래픽이 HTTP로 남지 않도록 ALB 또는 Ingress Controller 경계에서 HTTPS를 강제하는 것이다. 내부 재암호화나 서비스 간 mTLS는 별도 성숙도 항목으로 확장한다.

**Step 4: AWS Load Balancer Controller에서 HTTPS와 리다이렉트를 강제한다**

AWS Load Balancer Controller를 사용한다면 Ingress에 ACM 인증서 ARN, HTTP/HTTPS 리스너, SSL 리다이렉트, TLS 보안 정책을 명시한다.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  namespace: team-d
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:ap-northeast-2:111122223333:certificate/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'
    alb.ingress.kubernetes.io/ssl-redirect: '443'
    alb.ingress.kubernetes.io/ssl-policy: ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09
spec:
  ingressClassName: alb
  rules:
    - host: team-d.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
```

호환성 때문에 최신 post-quantum 정책을 바로 적용하기 어렵다면 최소 기준을 TLS 1.2 이상으로 두고 `ELBSecurityPolicy-TLS13-1-2-2021-06` 또는 `ELBSecurityPolicy-TLS13-1-2-Res-2021-06` 같은 TLS 1.3/TLS 1.2 정책을 선택한다. 단, 레거시 클라이언트 지원을 이유로 TLS 1.0/1.1을 허용하는 정책을 계속 유지하지 않는다.

백엔드까지 HTTPS로 재암호화해야 한다면 대상 서비스가 HTTPS를 제공하도록 구성하고 다음 애너테이션을 추가한다.

```yaml
metadata:
  annotations:
    alb.ingress.kubernetes.io/backend-protocol: HTTPS
    alb.ingress.kubernetes.io/healthcheck-protocol: HTTPS
```

이때 애플리케이션 인증서, health check 경로, readiness probe, 보안 그룹 규칙을 함께 검토해야 한다.

**Step 5: nginx Ingress Controller를 사용하는 경우 TLS Secret과 redirect를 설정한다**

실습 환경처럼 `ingressClassName: nginx`를 유지한다면 ACM 인증서를 ALB에 직접 붙이는 방식이 아니라 Kubernetes TLS Secret 또는 cert-manager를 사용한다.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  namespace: team-d
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - team-d.example.com
      secretName: team-d-web-tls
  rules:
    - host: team-d.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
```

TLS Secret을 직접 만들 경우:

```bash
kubectl create secret tls team-d-web-tls \
  -n team-d \
  --cert=certificate.pem \
  --key=private-key.pem
```

운영에서는 수동 Secret 생성보다 cert-manager와 ACM Private CA, Let's Encrypt, 사내 CA를 연동해 갱신을 자동화하는 편이 안전하다. 단, 인터넷 공개 서비스에서 Let's Encrypt를 쓴다면 ACME challenge 경로와 rate limit도 운영 절차에 포함한다.

**Step 6: 인증서 만료 알람과 변경 관리를 구성한다**

ACM 관리형 인증서는 DNS 검증과 연결 상태가 유지되면 자동 갱신되지만, 가져온 인증서나 Kubernetes TLS Secret은 별도 갱신 절차가 필요하다.

- ACM 인증서 만료 이벤트를 EventBridge와 SNS 또는 Slack 알림으로 연결한다.
- 수동으로 가져온 인증서는 만료 30일 전 교체 작업을 예약한다.
- Kubernetes TLS Secret 기반이면 cert-manager `Certificate` 상태와 `expiration` 메트릭을 모니터링한다.
- Ingress 매니페스트 변경은 GitOps 또는 IaC로 관리해 HTTP 예외가 코드 리뷰 없이 추가되지 않게 한다.

#### 검증 방법

먼저 Kubernetes 리소스가 의도한 설정을 갖고 있는지 확인한다.

```bash
kubectl get ingress web -n team-d -o yaml
```

AWS Load Balancer Controller를 사용하는 경우 다음 항목이 보여야 한다.

- `alb.ingress.kubernetes.io/certificate-arn`
- `alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'`
- `alb.ingress.kubernetes.io/ssl-redirect: '443'`
- TLS 1.2 이상을 강제하는 `alb.ingress.kubernetes.io/ssl-policy`

ALB 리스너도 확인한다.

```bash
aws elbv2 describe-listeners \
  --region "${AWS_REGION}" \
  --load-balancer-arn "${LOAD_BALANCER_ARN}" \
  --query 'Listeners[].{Port:Port,Protocol:Protocol,SslPolicy:SslPolicy,DefaultActions:DefaultActions[].Type,Certificates:Certificates[].CertificateArn}' \
  --output json
```

기대 결과는 443/HTTPS 리스너에 ACM 인증서와 최신 TLS 정책이 연결되어 있고, 80/HTTP 리스너의 기본 동작이 `redirect`인 것이다.

클라이언트 관점에서는 HTTPS 접속, HTTP 리다이렉트, 인증서 체인을 각각 확인한다.

```bash
curl -I https://team-d.example.com
curl -I http://team-d.example.com
```

기대 결과:

```http
HTTP/2 200
```

또는 애플리케이션 응답에 따라 `HTTP/1.1 200`이 나올 수 있다.

HTTP 요청은 HTTPS로 전환되어야 한다.

```http
HTTP/1.1 301 Moved Permanently
Location: https://team-d.example.com/
```

인증서 체인과 만료일을 확인한다.

```bash
openssl s_client -connect team-d.example.com:443 -servername team-d.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

TLS 1.0과 TLS 1.1이 거부되는지도 확인한다.

```bash
openssl s_client -connect team-d.example.com:443 -servername team-d.example.com -tls1 </dev/null
openssl s_client -connect team-d.example.com:443 -servername team-d.example.com -tls1_1 </dev/null
```

기대 결과는 handshake 실패다. TLS 1.2 또는 TLS 1.3은 성공해야 한다.

```bash
openssl s_client -connect team-d.example.com:443 -servername team-d.example.com -tls1_2 </dev/null
openssl s_client -connect team-d.example.com:443 -servername team-d.example.com -tls1_3 </dev/null
```

외부 검증이 가능한 공개 서비스라면 SSL Labs 같은 도구로 인증서 체인, 프로토콜, cipher suite, HSTS 적용 여부를 확인한다. HSTS는 적용 후 되돌리기 어렵기 때문에 도메인과 서브도메인 영향 범위를 검토한 뒤 단계적으로 켠다.

#### Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 공격자가 같은 네트워크, 프록시, 악성 Wi-Fi, 탈취된 라우팅 경로에서 HTTP 트래픽을 관찰해 세션 쿠키나 bearer token을 수집하고, 이를 이용해 사용자를 가장한다.
- **영향 범위:** 로그인 정보, API 토큰, 쿠키, 개인정보, 내부 API 응답이 평문으로 노출될 수 있으며 요청 변조를 통해 계정 탈취나 데이터 변조로 이어질 수 있다.
- **운영 리스크:** 인증서 만료나 잘못된 체인 구성은 브라우저 경고, 모바일 앱 장애, 외부 API 연동 실패로 이어진다. HTTP 예외 경로가 남아 있으면 일부 클라이언트가 계속 평문 통신을 사용할 수 있다.
- **규정 준수 영향:** 개인정보, 결제, 인증 정보를 다루는 서비스에서 전송 구간 암호화 미적용은 보안 심사와 규정 준수 실패 사유가 될 수 있다.
- **심각도:** **높음**. 외부 진입점의 평문 통신은 자격 증명 탈취와 중간자 공격으로 바로 연결될 수 있다.

#### 인적 리소스 및 비용

- **담당자 및 예상 소요 시간:** 플랫폼 엔지니어 1명 기준으로 인증서 발급 및 DNS 검증 30분~1시간, Ingress 변경 30분, 리다이렉트와 TLS 정책 검증 30분 내외
- **AWS 비용 발생 여부 및 예상 규모:** 공인 ACM 인증서 자체는 무료다. ALB, NLB, Route 53 hosted zone, DNS query, Load Balancer LCU 비용은 별도로 발생한다.
- **간접 비용:** 가져온 인증서, 사내 CA, ACM Private CA, cert-manager 운영을 선택하면 갱신 자동화와 모니터링 운영 부담이 생긴다.
- **오픈소스 vs 상용 도구 선택 시 비용 차이:** cert-manager는 오픈소스로 사용할 수 있다. ACM Private CA, 상용 인증서, 상용 모니터링 도구를 선택하면 월별 고정 비용 또는 인증서 발급 비용이 발생한다.

#### 참고 자료

- [SSL Redirect with AWS Load Balancer Controller](https://kubernetes-sigs.github.io/aws-load-balancer-controller/v2.7/guide/tasks/ssl_redirect/)
- [AWS Load Balancer Controller annotations](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/)
- [Security policies for your Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/describe-ssl-policies.html)
- [AWS Certificate Manager User Guide](https://docs.aws.amazon.com/acm/latest/userguide/acm-overview.html)
- [Kubernetes Ingress 공식 문서](https://kubernetes.io/docs/concepts/services-networking/ingress/)
- [cert-manager documentation](https://cert-manager.io/docs/)

#### 연계된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 연결된다.

- **CIS Controls v8**
  `3.10 Encrypt Sensitive Data in Transit`
  민감 데이터가 네트워크를 통해 이동할 때 강한 암호화를 적용하도록 요구한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  외부로 노출되는 Kubernetes 서비스의 네트워크 경계를 줄이고, 클러스터 통신 경로에서 암호화와 인증을 적용하는 방어 심층화 원칙과 연결된다.
- **AWS Well-Architected Framework - Security Pillar**
  전송 중 데이터 보호, 인증서 수명주기 관리, 암호화 정책 표준화와 직접 연결된다.

#### Assessment 체크리스트

- [ ] 외부 공개 Ingress 또는 Service type `LoadBalancer`가 HTTPS 리스너를 제공하는가?
- [ ] `http://` 요청이 `https://`로 강제 리다이렉트되는가?
- [ ] ALB 사용 시 `certificate-arn`, `listen-ports`, `ssl-redirect`, `ssl-policy`가 명시되어 있는가?
- [ ] TLS 정책이 TLS 1.2 이상을 강제하며 TLS 1.0/1.1을 허용하지 않는가?
- [ ] 인증서 SAN이 실제 서비스 도메인과 일치하고 인증서 체인이 정상인가?
- [ ] 인증서 만료 알람 또는 자동 갱신 절차가 구성되어 있는가?
- [ ] 백엔드 재암호화가 필요한 서비스는 `backend-protocol: HTTPS` 또는 Ingress Controller TLS 구성이 적용되어 있는가?
- [ ] HTTP 예외 경로가 GitOps/IaC 코드 리뷰 없이 추가될 수 없도록 관리되는가?
