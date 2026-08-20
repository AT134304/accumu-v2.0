// Accumu v2 — 관리자의 담당 학생 비밀번호 초기화 (docs/adr/0019-admin-password-reset.md)
//
// [배경] 학생/관리자 계정은 {학번/관리자코드}@accumu.local 가상 이메일이라 Supabase 표준
//   "이메일로 재설정 링크 발송"이 원천적으로 통하지 않는다(그 도메인엔 받는사람이 없다). 개인/소셜
//   계정(실제 이메일)은 이 문제가 없다 — 이 함수는 가상 이메일 계정 중 "학생" 쪽만 다룬다.
//   관리자 본인이 비밀번호를 잊었을 때는 여전히 이 함수의 대상이 아니다(1인 시연 — Supabase
//   대시보드에서 직접 바꾼다. ADR 0019 "알려진 사항").
//
// [★ 이 함수가 지키는 권한 경계 — naver-auth/google-auth와 다른 지점]
//   저 둘은 로그인 *전* 호출이라 --no-verify-jwt로 배포한다. 이 함수는 로그인한 관리자만 불러야 하므로
//   **기본값(JWT 검증 ON)으로 배포한다** — Authorization 헤더의 서명이 유효하지 않으면 이 코드가
//   실행되기도 전에 플랫폼이 거부한다.
//   그것만으로는 "로그인했다"만 보장하지 "그 학생의 담당 관리자다"는 보장하지 않는다. 그래서 두 번째
//   검사를 한다 — service_role이 아니라 **호출자의 Authorization 헤더를 그대로 실은 클라이언트**로
//   mentor_students를 읽는다. RLS(mentor_students_select_own_as_admin: admin_id = auth.uid())가
//   이미 "내 담당 학생만" 을 강제하므로, 그 정책을 새로 베끼지 않고 그대로 재사용하는 것이다 —
//   여기서 로직이 갈리면(예: role 체크를 따로 짜면) 나중에 RLS와 여기 코드가 서로 다른 답을 낼 위험이
//   생긴다. 조회가 0행이면 관리자가 아니거나 그 학생의 담당이 아니거나 둘 중 하나이고, 어느 쪽이든
//   거부 사유는 같다("not_your_student")— 어느 쪽인지 구분해 알려주지 않는다(존재 여부를 캐내는 데
//   쓰이지 않도록).
//
// [비밀번호를 관리자가 정하지 않는다] 서버가 무작위 임시 비밀번호를 만들어 1회 응답으로 돌려준다.
//   관리자가 직접 타이핑하면 "1234" 같은 약한 값을 그대로 심을 위험이 있고, 그 값을 입력창에 남기면
//   화면 뒤에서 새는 경로가 하나 늘어난다. 이 함수는 값을 반환할 뿐 어디에도 저장하지 않는다 —
//   저장된 원문은 auth.users의 해시뿐이다(Supabase Admin API가 처리, 이 함수는 평문을 만들기만 한다).
//
// [배포]
//   supabase functions deploy admin-reset-student-password
//   (--no-verify-jwt를 주지 않는다 — 기본값(JWT 검증 ON)이 이 함수의 첫 번째 방어선이다)
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

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
// 플랫폼이 모든 Edge Function에 자동으로 주입한다(별도 secrets set 불필요) — google-auth/naver-auth와
// 달리 이 셋은 프로젝트별로 새로 설정할 필요가 없다.
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** 임시 비밀번호 생성 — 사람이 옮겨 적기 쉬운 문자만 쓴다(0/O, 1/l/I 처럼 헷갈리는 문자 제외). */
function randomTempPassword(): string {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

Deno.serve(async (req) => {
  // 요청별 CORS + 그 헤더를 쓰는 json(). 아래 본문의 json(...) 호출은 전부 이것을 쓴다.
  const cors = corsFor(req);
  const json = jsonWith(cors);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
    console.error('[admin-reset-student-password] 환경변수 누락');
    return json({ error: 'not_configured' }, 500);
  }

  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader) return json({ error: 'unauthorized' }, 401);

  let studentId = '';
  try {
    const body = await req.json();
    studentId = String(body?.student_id ?? '');
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  if (!studentId) return json({ error: 'bad_request' }, 400);

  // [권한 경계 — 위 파일 헤더 설명] 호출자의 토큰을 그대로 실은 클라이언트로 mentor_students를 읽는다.
  // service_role이 아니라 이 클라이언트로 확인해야 RLS가 그대로 적용된다.
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: mapping, error: mapError } = await callerClient
    .from('mentor_students')
    .select('student_id')
    .eq('student_id', studentId)
    .maybeSingle();

  if (mapError) {
    console.error('[admin-reset-student-password] mentor_students 조회 실패:', mapError);
    return json({ ok: false, error: 'lookup_failed' }, 500);
  }
  if (!mapping) {
    // 관리자가 아니거나, 담당 학생이 아니거나 — 어느 쪽인지 구분해 알려주지 않는다.
    return json({ ok: false, reason: 'not_your_student' }, 403);
  }

  const tempPassword = randomTempPassword();
  const { error: updateError } = await adminClient.auth.admin.updateUserById(studentId, {
    password: tempPassword,
  });
  if (updateError) {
    console.error('[admin-reset-student-password] 비밀번호 갱신 실패:', updateError);
    return json({ ok: false, reason: 'update_failed' }, 500);
  }

  // [감사 로그 — ADR 0025] 이 함수는 트리거가 잡을 수 없는 자리다(auth.users 를 Admin API 로 바꾼다).
  //   그래서 여기서 직접 남긴다. service_role 이라 RLS(정책 0개)를 우회한다.
  //   [actor 는 호출한 관리자다] 위에서 mentor_students 조회로 이미 신원이 확인된 세션이다.
  //   [★ 임시 비밀번호를 남기지 않는다] 로그에 평문이 들어가면 이 함수가 지키려던 것이 무너진다.
  //   실패해도 응답을 막지 않는다 — 비밀번호는 이미 바뀌었고, 그 사실을 못 돌려주는 쪽이 더 나쁘다.
  const { data: caller } = await callerClient.auth.getUser();
  const { error: auditError } = await adminClient.from('admin_audit').insert({
    actor_id: caller?.user?.id ?? null,
    action: 'password_reset',
    target_table: 'profiles',
    target_id: studentId,
    changes: null,
  });
  if (auditError) {
    console.error('[admin-reset-student-password] 감사 로그 기록 실패:', auditError);
  }

  return json({ ok: true, temp_password: tempPassword });
});
