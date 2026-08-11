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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
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

  return json({ ok: true, temp_password: tempPassword });
});
