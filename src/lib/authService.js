// Accumu v2 — 로그인 인증 서비스 레이어
// 처리 순서·에러 메시지는 docs/adr/0002-profiles-schema-and-login-verification.md
// "로그인 검증 흐름" 표를 그대로 따른다. 역할(role) 검사가 이름(name) 검사보다 먼저 실행되어야 한다.
import { supabase } from './supabaseClient';
import { buildVirtualEmail } from './virtualEmail';

export const STUDENT_CREDENTIAL_ERROR = '학번/이름 또는 비밀번호를 확인해주세요';
export const ADMIN_CREDENTIAL_ERROR = '관리자 코드 또는 비밀번호를 확인해주세요';
export const PERSONAL_CREDENTIAL_ERROR = '이메일 또는 비밀번호를 확인해주세요';
export const ROLE_MISMATCH_ERROR = '선택한 유형과 계정이 일치하지 않습니다';

async function fetchOwnProfile(userId) {
  return supabase.from('profiles').select('*').eq('id', userId).single();
}

/**
 * 학생 로그인 — 학번 + 이름 + 비밀번호 3가지 모두 일치해야 성공.
 * ADR 0002 순서:
 *   1. signInWithPassword(학번, 비밀번호)
 *   2. profiles 본인 행 조회
 *   3. role !== 'student' → signOut 후 유형 불일치 에러 (이름 검사보다 먼저)
 *   4. name 불일치 → signOut 후 자격증명 오류와 동일 문구
 */
export async function loginStudent({ studentId, name, password }) {
  const email = buildVirtualEmail(studentId);

  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !signInData?.user) {
    throw new Error(STUDENT_CREDENTIAL_ERROR);
  }

  const { data: profile, error: profileError } = await fetchOwnProfile(signInData.user.id);

  if (profileError || !profile) {
    await supabase.auth.signOut();
    throw new Error(STUDENT_CREDENTIAL_ERROR);
  }

  if (profile.role !== 'student') {
    await supabase.auth.signOut();
    throw new Error(ROLE_MISMATCH_ERROR);
  }

  if (profile.name.trim() !== name.trim()) {
    await supabase.auth.signOut();
    throw new Error(STUDENT_CREDENTIAL_ERROR);
  }

  return profile;
}

/**
 * 관리자 로그인 — 관리자 코드 + 비밀번호 2-factor (이름 대조 없음).
 */
export async function loginAdmin({ code, password }) {
  const email = buildVirtualEmail(code);

  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !signInData?.user) {
    throw new Error(ADMIN_CREDENTIAL_ERROR);
  }

  const { data: profile, error: profileError } = await fetchOwnProfile(signInData.user.id);

  if (profileError || !profile) {
    await supabase.auth.signOut();
    throw new Error(ADMIN_CREDENTIAL_ERROR);
  }

  if (profile.role !== 'admin') {
    await supabase.auth.signOut();
    throw new Error(ROLE_MISMATCH_ERROR);
  }

  return profile;
}

export async function logout() {
  await supabase.auth.signOut();
}

/* ==========================================================================
   회원가입 (docs/specs/auth-signup.md / ADR 0008)

   [★ 이 파일에서 role 을 정하지 않는다]
     signUp() 의 metadata 에 role 을 실어 보내지만 그건 *신청*일 뿐이다. 승인은 DB 트리거
     handle_new_user() 가 invite_codes 를 조회해서 한다 — 관리자 초대코드가 없으면 예외가 나고
     가입 자체가 롤백된다. 그래서 이 코드를 우회하거나 metadata 를 조작해도 관리자가 될 수 없다.
   [프로필을 여기서 만들지 않는다] profiles insert 정책이 0개다. 계정 생성과 프로필 생성이 같은
     트랜잭션이어야 유령 계정(auth 행만 있고 프로필이 없어 그 학번으로 영영 재가입 불가)이 안 생긴다.
   ========================================================================== */

/** 가입 실패 사유 → 화면 문구. 사유별로 다른 문장을 갖는 것이 이 맵의 목적이다. */
const SIGNUP_REASON_TEXT = {
  code_taken: '이미 등록된 계정입니다. 로그인해주세요.',
  invalid_code: '학번(또는 관리자 코드)을 확인해주세요.',
  invalid_school_invite: '초대코드를 확인해주세요. 담당 선생님께 받은 코드를 그대로 입력해주세요.',
  invalid_admin_invite: '관리자 초대코드가 올바르지 않습니다.',
  // [설정 문제이지 입력 문제가 아니다] Supabase 의 "Confirm email" 이 켜져 있으면 가입할 때마다
  //   확인 메일 발송을 시도하고, 가상 이메일(@accumu.local)은 받을 곳이 없는데도 발송 한도(무료 플랜
  //   시간당 2건)를 소모해 429 로 막힌다. 사용자가 입력을 고쳐서 해결할 수 있는 문제가 아니므로
  //   "다시 시도"라고만 말하지 않고 설정 문제임을 드러낸다(운영자가 곧 시연자다 — CLAUDE.md 1장).
  email_rate_limit:
    '메일 발송 한도로 가입이 일시적으로 막혔어요. Supabase 설정에서 이메일 확인(Confirm email)을 끄면 해결됩니다.',
  signup_disabled: '이 프로젝트에서 회원가입이 비활성화되어 있어요. Supabase 인증 설정을 확인해주세요.',
  email_taken: '이미 가입된 이메일입니다. 로그인해주세요.',
  invalid_email: '이메일 형식을 확인해주세요.',
};

export function signupReasonText(reason) {
  return SIGNUP_REASON_TEXT[reason] ?? '가입에 실패했어요. 잠시 후 다시 시도해 주세요.';
}

/**
 * 가입 전 사전 검증 (중복 코드 / 초대코드 유효성).
 *
 * [보안 경계가 아니다 — UX 계층이다] 우회하면 트리거와 profiles.code unique 가 최종 판정한다.
 *   여기서 먼저 거르는 이유는 트리거 예외가 "Database error saving new user" 같은 문구로 올라와
 *   사용자에게 그대로 보여줄 수 없기 때문이다(ADR 0008 결정 4).
 */
export async function checkSignupAvailability({ role, code, invite }) {
  const { data, error } = await supabase.rpc('check_signup_availability', {
    p_role: role,
    p_code: code,
    p_invite: invite || null,
  });
  if (error) throw error;
  return data ?? { ok: false, reason: 'unknown' };
}

/**
 * 공통 가입 처리. 성공하면 세션이 생기고(AuthContext 가 이어받는다) 프로필이 함께 만들어져 있다.
 *
 * @returns {Promise<{ok:true, session:boolean} | {ok:false, reason:string}>}
 *   session=false 는 "가입은 됐는데 세션이 없다" = Supabase 의 Confirm email 설정이 켜진 경우다.
 *   가상 이메일이라 확인 메일을 받을 수 없으므로 화면은 로그인 화면으로 안내한다.
 */
async function signUpWithProfile({ role, code, name, password, invite, careerInterest }) {
  const pre = await checkSignupAvailability({ role, code, invite });
  if (!pre.ok) return { ok: false, reason: pre.reason };

  const { data, error } = await supabase.auth.signUp({
    email: buildVirtualEmail(code),
    password,
    options: {
      // 트리거가 읽는 값. role 은 신청이고 invite 가 그 신청의 근거다(위 주석 참고).
      data: {
        role,
        code: code.trim(),
        name: name.trim(),
        invite: invite ? invite.trim() : null,
        career_interest: careerInterest || null,
      },
    },
  });

  if (error) {
    console.error('[authService] 회원가입 실패:', error);
    const message = error.message ?? '';
    // 트리거가 던진 사유는 message 로 올라온다. 초대코드 문제면 그 문장을 그대로 쓴다.
    if (/초대코드/.test(message)) {
      return { ok: false, reason: role === 'admin' ? 'invalid_admin_invite' : 'invalid_school_invite' };
    }
    if (/already registered|User already/i.test(message)) {
      return { ok: false, reason: 'code_taken' };
    }
    // 프로젝트 설정 문제 2종 — 입력을 고쳐도 해결되지 않으므로 사유를 구분해 올린다.
    if (error.code === 'over_email_send_rate_limit' || /email rate limit/i.test(message)) {
      return { ok: false, reason: 'email_rate_limit' };
    }
    if (error.code === 'signup_disabled' || /signups not allowed/i.test(message)) {
      return { ok: false, reason: 'signup_disabled' };
    }
    return { ok: false, reason: 'unknown' };
  }

  return { ok: true, session: Boolean(data?.session) };
}

/** 학생 가입. invite 가 없으면 개인 계정, 있으면 그 코드의 관리자와 연동된 학교 계정이 된다. */
export async function signUpStudent({ studentId, name, password, invite, careerInterest }) {
  return signUpWithProfile({
    role: 'student',
    code: studentId,
    name,
    password,
    invite,
    careerInterest,
  });
}

/** 관리자 가입. 관리자 초대코드가 필수이며, 틀리면 학생으로 대신 만들어주지 않는다(fail-closed). */
export async function signUpAdmin({ code, name, password, invite }) {
  return signUpWithProfile({ role: 'admin', code, name, password, invite });
}

/* ==========================================================================
   개인 계정 — 학번이 없다 (docs/specs/auth-signup.md 개정 2026-07-31)

   [왜 학번을 받지 않는가] 개인 계정은 학교에 소속되지 않는다. 학번은 학교가 부여하는 식별자이므로
     받을 근거가 없고, 받으면 "아무 숫자나 학번처럼 입력된 값"이 unique 공간을 차지한다.
   [그럼 profiles.code 는] 서버가 'P-XXXXXX' 로 발급한다(generate_personal_code). 사람이 입력하거나
     외우는 값이 아니며, 로그인 아이디는 이메일(또는 소셜 계정)이다.
   ========================================================================== */

/**
 * 개인 계정 가입 (이메일 + 비밀번호). 학번·초대코드를 보내지 않는다 = 트리거가 개인 계정으로 만든다.
 *
 * [중복 이메일 판정] Supabase 는 계정 열거를 막으려고 이미 가입된 이메일에도 성공처럼 응답한다.
 *   그때 user.identities 가 빈 배열로 온다 — 그것이 유일한 신호다(문서화된 동작).
 */
export async function signUpPersonal({ email, password, name, careerInterest }) {
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      // code 를 싣지 않는다. 트리거가 그걸 보고 "학번 없는 개인 계정"으로 판정한다.
      data: { name: name.trim(), career_interest: careerInterest || null },
    },
  });

  if (error) {
    console.error('[authService] 개인 계정 가입 실패:', error);
    const message = error.message ?? '';
    if (error.code === 'over_email_send_rate_limit' || /email rate limit/i.test(message)) {
      return { ok: false, reason: 'email_rate_limit' };
    }
    if (error.code === 'signup_disabled' || /signups not allowed/i.test(message)) {
      return { ok: false, reason: 'signup_disabled' };
    }
    if (/already registered|User already/i.test(message)) return { ok: false, reason: 'email_taken' };
    if (/invalid.*email/i.test(message)) return { ok: false, reason: 'invalid_email' };
    return { ok: false, reason: 'unknown' };
  }

  if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return { ok: false, reason: 'email_taken' };
  }

  return { ok: true, session: Boolean(data?.session) };
}

/**
 * 개인 계정 로그인 (이메일 + 비밀번호).
 * 학교 계정의 loginStudent 와 달리 이름 대조가 없다 — 이메일 자체가 고유 식별자라 3-factor 가 성립하지 않는다.
 * role 검사는 그대로 한다(관리자 계정으로 이 폼에 들어오는 경로를 막는다).
 */
export async function loginPersonal({ email, password }) {
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });

  if (signInError || !signInData?.user) {
    throw new Error(PERSONAL_CREDENTIAL_ERROR);
  }

  const { data: profile, error: profileError } = await fetchOwnProfile(signInData.user.id);
  if (profileError || !profile) {
    await supabase.auth.signOut();
    throw new Error(PERSONAL_CREDENTIAL_ERROR);
  }
  if (profile.role !== 'student') {
    await supabase.auth.signOut();
    throw new Error(ROLE_MISMATCH_ERROR);
  }
  return profile;
}

/* ==========================================================================
   네이버 로그인 (docs/adr/0009-naver-login-via-edge-function.md)

   [Supabase 의 소셜 경로를 쓰지 않는다] 네이버는 Supabase 제공자 목록에 없고 OIDC id_token 도
     발급하지 않아 signInWithOAuth / signInWithIdToken 어느 쪽으로도 붙지 않는다. 그래서
     code -> token -> 프로필 -> 계정 -> 세션을 Edge Function(naver-auth)이 직접 잇는다.

   [★ 네이버로는 관리자가 될 수 없다] Edge Function 이 계정을 만들 때 metadata 에 name 만 넣는다.
     그러면 handle_new_user() 트리거의 "(c) 개인 이메일 가입" 분기를 타 학생 · 개인 계정으로 고정된다.
     이 파일이 role 이나 초대코드를 보낼 자리는 존재하지 않는다.

   [가입/로그인 구분이 없다] 첫 방문이면 계정이 생기고 아니면 로그인된다. 두 화면이 같은 버튼을 쓴다.
   ========================================================================== */

const NAVER_STATE_KEY = 'accumu:naver_state';

/** 네이버 로그인이 설정돼 있는가(클라이언트 ID 주입 여부). 버튼을 그릴지 판단하는 데 쓴다. */
export function isNaverConfigured() {
  return Boolean(import.meta.env.VITE_NAVER_CLIENT_ID);
}

/**
 * 네이버 인증 화면으로 이동한다.
 *
 * [state 는 CSRF 방어다] 여기서 만들어 sessionStorage 에 넣고, 돌아왔을 때 대조한다. 대조에 실패하면
 *   code 를 교환하지 않는다 — 남이 심어둔 code 로 남의 계정에 로그인되는 경로를 막는다.
 * [redirect_uri 는 앱 주소다] 구글·카카오와 달리 네이버는 Supabase 콜백이 아니라 우리 앱으로 직접
 *   돌아온다. 그래서 네이버 개발자센터에 등록하는 Callback URL 이 곧 이 값이다.
 */
export function startNaverLogin() {
  const clientId = import.meta.env.VITE_NAVER_CLIENT_ID;
  if (!clientId) throw new Error('NAVER_NOT_CONFIGURED');

  const state = crypto.randomUUID();
  sessionStorage.setItem(NAVER_STATE_KEY, state);

  const redirectUri = `${window.location.origin}/auth/naver`;
  window.location.href =
    'https://nid.naver.com/oauth2.0/authorize?response_type=code' +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;
}

/** 네이버 로그인 실패 사유 → 화면 문구. 설정 문제와 사용자 문제를 섞지 않는다. */
const NAVER_REASON_TEXT = {
  state_mismatch: '로그인 요청이 만료됐어요. 처음부터 다시 시도해 주세요.',
  denied: '네이버 로그인을 취소했어요.',
  not_configured: '네이버 로그인이 아직 설정되지 않았어요. (naver-auth 함수의 키를 확인해주세요)',
  token_exchange_failed: '네이버 인증에 실패했어요. 잠시 후 다시 시도해 주세요.',
  profile_failed: '네이버 프로필을 가져오지 못했어요. 제공 동의 항목을 확인해주세요.',
  create_failed: '계정을 만들지 못했어요. 잠시 후 다시 시도해 주세요.',
  session_failed: '로그인 세션을 만들지 못했어요. 잠시 후 다시 시도해 주세요.',
  function_missing: '네이버 로그인 함수(naver-auth)가 배포되지 않았어요.',
};

export function naverReasonText(reason) {
  return NAVER_REASON_TEXT[reason] ?? '네이버 로그인에 실패했어요. 잠시 후 다시 시도해 주세요.';
}

/**
 * 네이버가 돌려준 code 를 세션으로 바꾼다. /auth/naver 콜백 화면이 호출한다.
 *
 * [code 는 1회용이다] 두 번 교환하면 실패한다 — 호출부는 StrictMode 이중 실행을 ref 로 막아야 한다.
 * [세션은 verifyOtp 로 만든다] Edge Function 이 발급한 매직링크 token_hash 를 교환한다.
 *   Admin API 로는 access_token 을 직접 만들 수 없어서 택한 경로다(ADR 0009 결정 2).
 */
export async function completeNaverLogin({ code, state }) {
  const saved = sessionStorage.getItem(NAVER_STATE_KEY);
  sessionStorage.removeItem(NAVER_STATE_KEY);
  if (!saved || saved !== state) return { ok: false, reason: 'state_mismatch' };

  const { data, error } = await supabase.functions.invoke('naver-auth', { body: { code, state } });

  if (error) {
    console.error('[authService] naver-auth 호출 실패:', error);
    // 함수가 아직 배포되지 않은 경우와 함수 내부 실패를 구분해준다.
    const status = error.context?.status;
    if (status === 404) return { ok: false, reason: 'function_missing' };
    return { ok: false, reason: 'unknown' };
  }
  if (!data?.token_hash) return { ok: false, reason: data?.error ?? 'unknown' };

  const { error: otpError } = await supabase.auth.verifyOtp({
    token_hash: data.token_hash,
    type: 'magiclink',
  });
  if (otpError) {
    console.error('[authService] 세션 교환 실패:', otpError);
    return { ok: false, reason: 'session_failed' };
  }

  return { ok: true };
}
