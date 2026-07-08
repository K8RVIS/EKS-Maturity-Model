# eks-maturity-advisor MCP Server

`skills/eks-maturity-advisor`의 스캐너 로직을 **MCP(Model Context Protocol) 서버**로 노출합니다.
기존 Codex Skill(`SKILL.md` + 로컬 스크립트 실행)과 달리, 이 서버는 MCP를 지원하는
어떤 클라이언트(Claude Desktop, Claude Code, Cursor 등)에서도 **원격 URL로 접속해서** 같은
진단 기능을 도구(tool)로 호출할 수 있게 해줍니다.

## 왜 별도 디렉토리인가

레포 루트는 Astro 기반 문서 사이트(`astro.config.mjs`, `src/content/docs/...`)이고,
`skills/eks-maturity-advisor/`는 Codex Skill 정의입니다. MCP 서버는 이 둘과 목적이 달라서
(`Node 프로세스 + Express + MCP SDK`) 별도 `package.json`을 가진 독립 디렉토리로 분리했습니다.
스캐너 로직 자체는 새로 만들지 않고 `../skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs`를
그대로 import해서 재사용합니다.

```
mcp-server/
├── package.json     # @modelcontextprotocol/sdk, express, zod
├── server.mjs       # MCP 서버 본체 (아래 구조 설명)
└── README.md        # 이 파일
```

## server.mjs 구조

```
buildServer()          MCP 서버 인스턴스를 만들고 tool 2개를 등록
  ├─ scan_repo         scanRepository() 호출 → renderMarkdown()으로 변환해 반환
  └─ scan_live_cluster scanLiveCluster()  호출 → renderMarkdown()으로 변환해 반환

runStdio()              로컬 테스트용. node server.mjs --stdio
runHttp()                실제 배포용. Streamable HTTP 트랜스포트 + Express
  ├─ (선택) x-api-key 헤더 검증 미들웨어
  ├─ transports{}        mcp-session-id별로 StreamableHTTPServerTransport 보관
  ├─ POST /mcp           세션 초기화(initialize) 또는 기존 세션으로 요청 처리
  ├─ GET  /mcp           서버→클라이언트 스트림(SSE) 유지
  └─ DELETE /mcp         세션 종료
```

`buildServer()`가 요청마다(정확히는 세션마다) **새 인스턴스**를 만드는 게 핵심입니다 — MCP 서버는
세션 하나에 하나씩 붙는 구조라서, 여러 클라이언트가 동시에 접속해도 서로의 상태가 섞이지 않습니다.

### 왜 `inputSchema`가 `z.object({...})`가 아니라 `{ repoRoot: z.string() }`인가

MCP TypeScript SDK는 현재 두 세대가 공존합니다:

| | 패키지 | 상태 | `inputSchema` 형태 |
|---|---|---|---|
| v1 (이 프로젝트가 쓰는 것) | `@modelcontextprotocol/sdk` | 정식 릴리스 (1.29.0) | 순수 shape 객체 `{ key: z.string() }` |
| v2 | `@modelcontextprotocol/server` + `@modelcontextprotocol/express` | 베타 (2.0.0-beta.2) | `z.object({...})` 전체 스키마 |

과제 마감이 촉박해서 **정식 버전인 v1**로 골랐습니다. (실제로 npm에서 두 버전 다 버전 문자열을
확인하고 결정했습니다 — v2는 아직 `-beta` 태그가 붙어있습니다.)

## 로컬에서 돌려보기

```bash
cd mcp-server
npm install

# 방법 1: stdio (Claude Desktop 로컬 설정에 등록해서 테스트)
node server.mjs --stdio

# 방법 2: HTTP (아래 curl로 직접 확인 가능)
node server.mjs
```

HTTP 모드로 띄운 뒤 MCP 핸드셰이크를 직접 확인하려면:

```bash
# 1) initialize — mcp-session-id를 응답 헤더에서 받음
curl -i -X POST http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# 2) tools/list, tools/call — 위에서 받은 세션 ID를 mcp-session-id 헤더로 전달
curl -X POST http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: <위에서 받은 값>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"scan_repo","arguments":{"repoRoot":"/absolute/path/to/repo"}}}'
```

실제로 `eks-secure-infra` 레포를 대상으로 위 방식대로 검증했고, 정상적으로
Quick Wins 위반 항목(예: default ServiceAccount, Ingress TLS 누락)이 markdown으로 반환되는 것을 확인했습니다.

## MCP Inspector로 테스트하기 (Claude Desktop 없이)

Claude Desktop 같은 실제 AI 클라이언트에 연동하지 않고, **MCP 서버 자체만** 확인하고 싶을 때 쓰는
공식 도구입니다. curl로 직접 JSON-RPC를 치는 것보다 훨씬 편합니다.

```bash
cd mcp-server
npx @modelcontextprotocol/inspector node server.mjs --stdio
```

실행하면 터미널에 이렇게 뜹니다:

```
⚙️ Proxy server listening on localhost:6277
🔑 Session token: <토큰>

🚀 MCP Inspector is up and running at:
   http://localhost:6274/?MCP_PROXY_AUTH_TOKEN=<토큰>
```

이 URL을 브라우저로 열면(토큰이 쿼리스트링에 포함돼 있어 바로 인증됨):

1. **Transport Type: STDIO**, **Command: node**, **Arguments: server.mjs --stdio**가 이미 채워져 있음
   (`npx` 실행할 때 넘긴 값 그대로 반영된 것)
2. **Connect** 클릭
3. 상단 **Tools** 탭 → `scan_repo`, `scan_live_cluster` 목록 확인
4. `scan_repo` 선택 → `repoRoot`에 스캔할 레포의 절대경로 입력 → **Run Tool**
5. 아래에 실제 스캔 결과(markdown)가 그대로 출력됨

중간에 `ECONNREFUSED ... /.well-known/oauth-protected-resource` 류 에러 로그가 찍혀도 무시해도 됩니다 —
Inspector UI가 기본값으로 다른 포트(원격 SSE 서버용 기본 URL)를 한 번 찔러보고 실패하는 것뿐이고,
우리가 쓰는 stdio 연결과는 무관합니다.

HTTP 모드(`node server.mjs`, 세션 기반 Streamable HTTP)를 Inspector로 붙이고 싶으면 Transport Type을
**Streamable HTTP**로 바꾸고 URL에 `http://localhost:3000/mcp`를 넣으면 됩니다.

## 원격 배포 후 클라이언트 연결

서버를 아무 Node 호스트(EC2, 컨테이너 등)에 올리고 포트를 열어둔 다음, 클라이언트 설정에 URL만 등록하면 됩니다.

```json
{
  "mcpServers": {
    "eks-maturity-advisor": {
      "url": "https://<배포한-호스트>/mcp",
      "headers": { "x-api-key": "<MCP_API_KEY와 동일한 값>" }
    }
  }
}
```

## 보안 — 반드시 확인할 것

- `MCP_API_KEY` 환경변수를 설정하지 않으면 **URL을 아는 누구나** `scan_live_cluster`로
  실제 AWS/kubectl 명령을 실행시킬 수 있습니다. 배포 전에 반드시 설정하세요.
  ```bash
  MCP_API_KEY=<임의의-긴-문자열> node server.mjs
  ```
- `scan_live_cluster`는 코드상으로는 read-only(`kubectl get`, `aws describe/list/get`)만
  실행하도록 만들어져 있지만, 서버를 실행하는 자격증명(AWS 프로필/kubeconfig) 자체의
  권한 범위는 별개로 최소화해두는 게 안전합니다.

## 미해결/TODO

- [ ] 세션이 메모리(`transports{}`)에만 저장되어 있어 서버 재시작 시 진행 중이던 세션이 끊깁니다.
      영속화가 필요하면 SDK의 `eventStore` 옵션(재개 가능한 스트림)을 추가로 검토하세요.
- [ ] 현재 HTTP 배포 위치 미정 — 팀 컨벤션대로 `environment-manager`처럼 Lambda 컨테이너로 갈지,
      단순 VM/컨테이너로 갈지는 배포 시점에 결정.

## 참고 자료

- [Model Context Protocol 공식 사이트](https://modelcontextprotocol.io) 
- [MCP TypeScript SDK 저장소](https://github.com/modelcontextprotocol/typescript-sdk) — `@modelcontextprotocol/sdk` (v1, 이 프로젝트가 쓰는 정식 버전) 소스
  - [`src/examples/server/simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/examples/server/simpleStreamableHttp.ts) — `server.mjs`의 세션 관리(`transports{}`, `mcp-session-id`, `isInitializeRequest`) 구조를 그대로 참고한 공식 예제
- [npm: `@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — 현재 1.29.0, 정식 릴리스
- [npm: `@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server) / [`@modelcontextprotocol/express`](https://www.npmjs.com/package/@modelcontextprotocol/express) — 차세대 v2 SDK, 아직 2.0.0-beta.2라 이번엔 채택하지 않음
- [Zod](https://zod.dev) — `inputSchema` 검증에 사용
- `../skills/eks-maturity-advisor/SKILL.md` — MCP 서버가 감싸고 있는 원본 스캐너 로직/규칙 문서
