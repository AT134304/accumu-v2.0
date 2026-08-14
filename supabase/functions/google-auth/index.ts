// Accumu v2 — 구글 로그인 교환 함수 (docs/adr/0011-google-login-via-edge-function.md)
//
// [왜 Supabase 기본 제공자를 쓰지 않는가 — ADR 0010 결정 1의 번복]
//   구글은 Supabase 가 지원하므로 signInWithOAuth 한 줄로도 붙는다. 그런데 그렇게 하면 두 제공자의
//   운영 방식이 갈린다: 네이버는 "함수 배포 + secrets", 구글은 "대시보드 토글 + URL 허용목록".
//   고장났을 때 볼 곳도, 고치는 방법도 서로 다르다. 케빈 결정(2026-08-06): **두 제공자를 같은 경로로
//   통일한다.** 이 함수는 naver-auth 와 의도적으로 같은 모양이다 — 한쪽을 고치면 다른 쪽도 같이 본다.
//
// [★ 이 함수가 지켜야 하는 것 — naver-auth 와 완전히 같다]
//   1. 클라이언트가 보낸 값으로 role / code / invite 를 정하지 않는다. createUser 에 넘기는 metadata 는
//      name 하나뿐이다. 그래서 handle_new_user() 트리거의 "(c) 개인 이메일 가입" 분기를 타고
//      **언제나 학생 · 개인 계정**이 된다. 구글로 관리자가 되는 경로는 존재하지 않는다.
//   2. 계정 식별의 근거는 구글이 준 프로필뿐이다. 프런트가 보낸 email/name 을 신뢰하지 않는다
//      (애초에 받지 않는다 — 입력은 code/state 두 개다).
//   3. service_role 키는 함수 환경변수로만 존재한다. 프런트 번들에 들어가지 않는다.
//
// [redirect_uri 를 프런트에서 받지 않는 이유 — 네이버와 다른 유일한 지점]
//   구글 토큰 엔드포인트는 authorize 때 쓴 redirect_uri 를 **똑같이** 요구한다(네이버는 요구하지 않는다).
//   그 값을 본문으로 받으면 규칙 2("입력은 code/state 두 개")가 깨진다. 그래서 **브라우저가 붙이는
//   Origin 헤더**에서 서버가 직접 만든다. 페이지 스크립트는 Origin 을 위조할 수 없고, 설령 위조해도
//   구글이 "그 code 가 발급된 redirect_uri" 와 대조해 거부한다(등록된 주소만 통과).
//
// [배포]
//   supabase secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
//   supabase functions deploy google-auth --no-verify-jwt
//   (--no-verify-jwt: 로그인 전 호출이라 Authorization 헤더에 사용자 JWT 가 없다)
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '';
// Origin 헤더가 없는 환경(테스트 도구 등)을 위한 대비책. 평소에는 쓰이지 않는다.
const GOOGLE_REDIRECT_URI = Deno.env.get('GOOGLE_REDIRECT_URI') ?? '';

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  // service_role — RLS 를 우회한다. 이 키가 하는 일은 아래 두 가지뿐이어야 한다:
  //   (1) 계정 조회/생성  (2) 세션 교환용 매직링크 토큰 발급
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
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
  // state 는 프런트가 sessionStorage 로 대조한다(이 함수는 브라우저 세션을 모른다).
  // 여기서는 "빠짐 없이 왔는가"만 본다 — naver-auth 와 같은 계약이다.
  if (!code || !state) return json({ error: 'bad_request' }, 400);

  const origin = req.headers.get('origin') ?? '';
  const redirectUri = origin ? `${origin}/auth/google` : GOOGLE_REDIRECT_URI;
  if (!redirectUri) {
    console.error('[google-auth] redirect_uri 를 만들 수 없음: Origin 헤더 없음 + GOOGLE_REDIRECT_URI 미설정');
    return json({ error: 'bad_request' }, 400);
  }

  // (1) code -> access_token
  //     네이버는 GET + 쿼리스트링이지만 구글은 POST + form-urlencoded 다.
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
    }),
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!token?.access_token) {
    console.error('[google-auth] 토큰 교환 실패:', token);
    return json({ error: 'token_exchange_failed' }, 400);
  }

  // (2) 프로필 조회 — 계정 식별의 유일한 근거다.
  //     id_token 을 열어도 같은 값을 얻지만, 그러려면 서명 검증을 우리가 해야 한다.
  //     userinfo 엔드포인트는 access_token 으로 구글에게 직접 묻는 것이라 검증이 필요 없다.
  const meRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const me = await meRes.json().catch(() => ({}));
  if (!me?.sub) {
    console.error('[google-auth] 프로필 조회 실패:', me);
    return json({ error: 'profile_failed' }, 400);
  }

  // 구글은 email 스코프를 받으면 거의 항상 이메일을 준다. 그래도 없을 때를 대비해 고유 id(sub)로
  // 안정적인 주소를 만든다(같은 사람이 다시 로그인해도 같은 값이라 계정이 하나로 유지된다).
  const email: string = me.email ?? `google_${me.sub}@accumu.local`;
  const name: string = (me.name ?? me.given_name ?? '').trim() || '이름 미설정';

  // (3) 계정 확보. metadata 는 name 하나뿐 — code/role/invite 를 넣지 않는 것이 권한 경계다.
  //     그 결과 handle_new_user() 가 학생 · 개인 계정으로 만들고 code 를 P-XXXXXX 로 발급한다.
  let userId: string | null = null;
  const { data: existing, error: lookupError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (lookupError) {
    console.error('[google-auth] 사용자 조회 실패:', lookupError);
    return json({ error: 'lookup_failed' }, 500);
  }
  const found = existing.users.find((u) => u.email === email);
  if (found) {
    userId = found.id;
    // [auth_provider 소급 기록 — 2026-08-14] naver-auth 와 같은 처리. 두 함수는 같은 모양이니
    // 한쪽을 고치면 다른 쪽도 같이 볼 것(CLAUDE.md 4장).
    if (found.user_metadata?.auth_provider !== 'google') {
      const { error: markError } = await admin.auth.admin.updateUserById(found.id, {
        user_metadata: { ...found.user_metadata, auth_provider: 'google' },
      });
      if (markError) console.error('[google-auth] auth_provider 기록 실패:', markError);
    }
  } else {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true, // 가상 주소일 수 있어 확인 메일을 보낼 수 없다(보내서도 안 된다)
      // [auth_provider 는 클라이언트 인자가 아니라 서버가 아는 사실이다 — 2026-08-14]
      //   naver-auth 와 같은 이유·같은 판단이다(그쪽 주석에 근거를 적어 뒀다). 요약하면:
      //   소셜 계정은 admin.createUser 로 만들어져 provider 가 'email' 로 보이기 때문에,
      //   프런트가 이메일/비밀번호 개인 계정과 구분할 수단이 이 표식뿐이다.
      //   role/code/invite 를 metadata 에 넣지 않는 규율은 그대로다.
      user_metadata: { name, auth_provider: 'google' },
    });
    if (createError || !created?.user) {
      console.error('[google-auth] 계정 생성 실패:', createError);
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
    console.error('[google-auth] 매직링크 발급 실패:', linkError);
    return json({ error: 'session_failed' }, 500);
  }

  return json({ token_hash: link.properties.hashed_token, user_id: userId });
});
