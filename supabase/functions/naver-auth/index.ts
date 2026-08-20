// Accumu v2 — 네이버 로그인 교환 함수 (docs/adr/0009-naver-login-via-edge-function.md)
//
// [왜 서버 조각이 필요한가]
//   Supabase 는 네이버를 소셜 제공자로 지원하지 않고, 네이버는 OIDC id_token 도 발급하지 않는다.
//   그래서 signInWithOAuth / signInWithIdToken 어느 쪽으로도 붙지 않는다. code -> token -> 프로필 ->
//   Supabase 계정 -> 세션까지를 직접 이어야 하고, 그 중 "계정 생성"과 "세션 발급"이 service_role 을 요구한다.
//
// [★ 이 함수가 지켜야 하는 것 — 여기가 이 프로젝트에서 가장 위험한 코드다]
//   1. 클라이언트가 보낸 값으로 role / code / invite 를 정하지 않는다. createUser 에 넘기는 metadata 는
//      name 하나뿐이다. 그래서 handle_new_user() 트리거의 "(c) 개인 이메일 가입" 분기를 타고
//      **언제나 학생 · 개인 계정**이 된다. 네이버로 관리자가 되는 경로는 존재하지 않는다.
//   2. 계정 식별의 근거는 네이버가 준 프로필뿐이다. 프런트가 보낸 email/name 을 신뢰하지 않는다
//      (애초에 받지 않는다 — 입력은 code/state 두 개다).
//   3. service_role 키는 함수 환경변수로만 존재한다. 프런트 번들에 들어가지 않는다.
//
// [배포]
//   supabase secrets set NAVER_CLIENT_ID=... NAVER_CLIENT_SECRET=...
//   supabase functions deploy naver-auth --no-verify-jwt
//   (--no-verify-jwt: 로그인 전 호출이라 Authorization 헤더에 사용자 JWT 가 없다)
import { createClient } from 'jsr:@supabase/supabase-js@2';

// =============================================================================
// [CORS 오리진 허용목록 — 2026-08-20]
//
//   전에는 'Access-Control-Allow-Origin': '*' 였다. 아무 웹페이지나 브라우저에서 이 함수를 부를 수
//   있다는 뜻이고, 응답을 읽을 수도 있었다. 세 함수 모두 그것만으로 계정이 털리진 않지만
//   (이 함수의 진짜 방어선은 JWT 검증 / OAuth code 대조다), **경계를 한 겹 더 두는 쪽**을 고른다.
//
// [허용 규칙 3가지]
//   1) 환경변수 ALLOWED_ORIGINS 에 콤마로 나열한 주소 (배포 도메인을 여기에 넣는다)
//        supabase secrets set ALLOWED_ORIGINS=https://accumu.example.com
//   2) http://localhost:*, http://127.0.0.1:*  (개발 서버)
//   3) https://*.vercel.app                    (배포/프리뷰 — 도메인을 몰라도 시연이 막히지 않게)
//   >>> 3번은 "vercel 에 올린 아무 사이트"까지 여는 느슨한 규칙이다. 배포 주소가 정해지면 1번에
//   >>> 넣고 3번을 지우는 것이 맞다. 지금은 시연이 조용히 깨지는 쪽이 더 비싸서 남겨둔다.
//
// [허용되지 않으면 Allow-Origin 헤더를 아예 안 붙인다] 브라우저가 응답을 읽지 못한다.
//   요청 자체를 403 으로 막지는 않는다 — CORS 는 브라우저의 규칙이고, 서버측 경계는 각 함수의
//   JWT 검증/OAuth 대조가 따로 갖고 있다. 여기서 403 을 내면 두 경계가 겹쳐 원인 파악만 어려워진다.
//
// [세 함수에 같은 코드가 복사돼 있다] admin-reset-student-password / naver-auth / google-auth.
//   Edge Function 은 각자 배포 단위라 자기완결적으로 두는 기존 관례(시딩 스크립트와 같은 판단)를
//   따랐다. >>> 한쪽을 고치면 나머지 둘도 같이 고칠 것.
// =============================================================================
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
  if (u.protocol === 'https:' && u.hostname.endsWith('.vercel.app')) return true;
  return false;
}

/** 요청의 Origin 을 보고 응답 헤더를 만든다. 허용 밖이면 Allow-Origin 을 붙이지 않는다. */
function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const base: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    // 오리진마다 응답 헤더가 달라지므로 캐시가 섞이지 않게 알려준다.
    Vary: 'Origin',
  };
  if (isAllowedOrigin(origin)) base['Access-Control-Allow-Origin'] = origin;
  return base;
}

/** 요청별 CORS 헤더를 닫아 넣은 json() 을 만든다(핸들러 첫 줄에서 만들어 쓴다). */
function jsonWith(cors: Record<string, string>) {
  return (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
}

const NAVER_CLIENT_ID = Deno.env.get('NAVER_CLIENT_ID') ?? '';
const NAVER_CLIENT_SECRET = Deno.env.get('NAVER_CLIENT_SECRET') ?? '';

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  // service_role — RLS 를 우회한다. 이 키가 하는 일은 아래 두 가지뿐이어야 한다:
  //   (1) 계정 조회/생성  (2) 세션 교환용 매직링크 토큰 발급
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

Deno.serve(async (req) => {
  // 요청별 CORS + 그 헤더를 쓰는 json(). 아래 본문의 json(...) 호출은 전부 이것을 쓴다.
  const cors = corsFor(req);
  const json = jsonWith(cors);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
    // 설정 누락은 사용자 잘못이 아니다. 사유를 분명히 구분해 올린다.
    return json({ error: 'not_configured' }, 500);
  }

  let code = '';
  let state = '';
  try {
    const body = await req.json();
    code = String(body?.code ?? '');
    state = String(body?.state ?? '');
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  if (!code || !state) return json({ error: 'bad_request' }, 400);

  // (1) code -> access_token
  //     state 는 네이버 규격상 함께 보내야 한다. CSRF 대조 자체는 프런트가 sessionStorage 로 한다
  //     (이 함수는 브라우저 세션을 알지 못한다).
  const tokenUrl =
    `https://nid.naver.com/oauth2.0/token?grant_type=authorization_code` +
    `&client_id=${encodeURIComponent(NAVER_CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(NAVER_CLIENT_SECRET)}` +
    `&code=${encodeURIComponent(code)}` +
    `&state=${encodeURIComponent(state)}`;

  const tokenRes = await fetch(tokenUrl);
  const token = await tokenRes.json().catch(() => ({}));
  if (!token?.access_token) {
    console.error('[naver-auth] 토큰 교환 실패:', token);
    return json({ error: 'token_exchange_failed' }, 400);
  }

  // (2) 프로필 조회 — 계정 식별의 유일한 근거다.
  const meRes = await fetch('https://openapi.naver.com/v1/nid/me', {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const me = await meRes.json().catch(() => ({}));
  const p = me?.response;
  if (!p?.id) {
    console.error('[naver-auth] 프로필 조회 실패:', me);
    return json({ error: 'profile_failed' }, 400);
  }

  // 이메일 제공은 네이버 검수 대상이라 없을 수 있다. 없으면 네이버 고유 id 로 안정적인 주소를 만든다
  // (같은 사람이 다시 로그인해도 같은 값이라 계정이 하나로 유지된다).
  const email: string = p.email ?? `naver_${p.id}@accumu.local`;
  const name: string = (p.name ?? p.nickname ?? '').trim() || '이름 미설정';

  // (3) 계정 확보. metadata 는 name 하나뿐 — code/role/invite 를 넣지 않는 것이 권한 경계다.
  //     그 결과 handle_new_user() 가 학생 · 개인 계정으로 만들고 code 를 P-XXXXXX 로 발급한다.
  let userId: string | null = null;
  const { data: existing, error: lookupError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (lookupError) {
    console.error('[naver-auth] 사용자 조회 실패:', lookupError);
    return json({ error: 'lookup_failed' }, 500);
  }
  const found = existing.users.find((u) => u.email === email);
  if (found) {
    userId = found.id;
    // [auth_provider 소급 기록 — 2026-08-14] 아래 createUser 주석 참고. 이 표식이 생기기 전에
    // 만들어진 계정은 아직 없으므로 다음 로그인 때 한 번 채워 준다(이미 있으면 건너뛴다).
    if (found.user_metadata?.auth_provider !== 'naver') {
      const { error: markError } = await admin.auth.admin.updateUserById(found.id, {
        user_metadata: { ...found.user_metadata, auth_provider: 'naver' },
      });
      // 실패해도 로그인은 계속한다 — 이 값은 화면 표시용이지 권한 경계가 아니다.
      if (markError) console.error('[naver-auth] auth_provider 기록 실패:', markError);
    }
  } else {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true, // 가상 주소일 수 있어 확인 메일을 보낼 수 없다(보내서도 안 된다)
      // [auth_provider 는 클라이언트 인자가 아니라 서버가 아는 사실이다 — 2026-08-14]
      //   위 "metadata 는 name 하나뿐" 규율의 취지는 **클라이언트가 보낸 값으로 권한을 정하지
      //   않는다**는 것이다(ADR 0009 결정 3). 이 값은 요청 본문에서 오지 않고 이 함수가 어느
      //   제공자인지로 결정하므로 그 가드에 걸리지 않는다. role/code/invite 는 여전히 금지다.
      //   [왜 필요한가] 소셜 계정은 admin.createUser 로 만들어져 provider 가 'email' 로 보인다 —
      //   프런트에서 이메일/비밀번호 개인 계정과 구분할 방법이 이것 말고 없다. 마이페이지가 이
      //   값을 보고 "비밀번호 변경" 칸을 숨긴다(소셜 계정에는 바꿀 비밀번호가 없다).
      user_metadata: { name, auth_provider: 'naver' },
    });
    if (createError || !created?.user) {
      console.error('[naver-auth] 계정 생성 실패:', createError);
      return json({ error: 'create_failed' }, 500);
    }
    userId = created.user.id;
  }

  // (4) 세션 교환용 토큰.
  //     [왜 매직링크인가] Admin API 로는 access_token 을 직접 발급할 수 없다. 임의 비밀번호를 심어
  //     signInWithPassword 하는 우회는 기존 비밀번호를 덮어쓰고 서버가 비밀번호를 알게 되므로 쓰지 않는다.
  //     여기서 만든 token_hash 는 1회용이고 프런트가 verifyOtp 로 세션과 교환한다.
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (linkError || !link?.properties?.hashed_token) {
    console.error('[naver-auth] 매직링크 발급 실패:', linkError);
    return json({ error: 'session_failed' }, 500);
  }

  return json({ token_hash: link.properties.hashed_token, user_id: userId });
});
