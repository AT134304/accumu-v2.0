// Accumu v2 — 로그인 인증 서비스 레이어
// 처리 순서·에러 메시지는 docs/adr/0002-profiles-schema-and-login-verification.md
// "로그인 검증 흐름" 표를 그대로 따른다. 역할(role) 검사가 이름(name) 검사보다 먼저 실행되어야 한다.
import { supabase } from './supabaseClient';
import { buildVirtualEmail } from './virtualEmail';

export const STUDENT_CREDENTIAL_ERROR = '학번/이름 또는 비밀번호를 확인해주세요';
export const ADMIN_CREDENTIAL_ERROR = '관리자 코드 또는 비밀번호를 확인해주세요';
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
