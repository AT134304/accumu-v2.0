#!/usr/bin/env node
/**
 * scripts/seed-accounts.mjs
 *
 * Accumu v2 — 데모 계정 시딩 스크립트
 * (ADR 0002 "데모 계정 시딩" 절차 그대로 구현, docs/adr/0002-profiles-schema-and-login-verification.md 참고)
 *
 * 목적: docs/specs/auth-login.md의 "확정된 데모 계정" 표(학생 5 + 관리자 1)를
 *   1) Supabase Auth 계정으로 생성 (가상 이메일 {code}@accumu.local, 비밀번호 accumu2026)
 *   2) public.profiles 행으로 함께 생성 (career_interest 포함 — ADR 0003, 아래 참고)
 *   3) 관리자 1명(ADM-0001)이 학생 5명 전원을 담당하도록 public.mentor_students에 매핑
 * 하는 1회성 스크립트.
 *
 * 전제 조건
 *   - supabase/migrations/*.sql 이 대상 Supabase 프로젝트에 이미 적용되어 있어야 함
 *     (user_role/career_track enum, public.profiles, public.mentor_students 테이블 존재)
 *   - .env.seed 파일에 SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 값이 채워져 있어야 함
 *     (.env.seed.example 참고). SUPABASE_SERVICE_ROLE_KEY는 RLS를 우회하는 매우 민감한 키이므로
 *     절대 커밋하거나 프런트엔드 코드/번들에 노출하지 않는다.
 *
 * 실행 방법 (Supabase 프로젝트 URL/service_role key를 받은 뒤에만 실행)
 *   1. cp .env.seed.example .env.seed  # 값 채우기
 *   2. cd scripts && npm install
 *   3. node seed-accounts.mjs
 *
 * [실행 순서] 마이그레이션 -> seed-accounts.mjs(이 파일) -> seed-programs.mjs
 *   seed-programs.mjs 는 programs.created_by 를 채우려고 code='ADM-0001' 프로필을 조회하므로
 *   반드시 이 스크립트가 먼저 실행되어야 한다.
 *
 * 재실행 안전성(idempotency)은 이번 스코프 요구사항이 아니다 (ADR 0002 "데모 계정 시딩" 4번).
 * 신규 Supabase 프로젝트에 1회 실행하는 것을 전제로 하며, 이미 계정이 존재하는 상태에서
 * 재실행하면 이메일 중복 에러로 스크립트가 즉시 중단되는 것이 기본 동작이다. (의도된 동작)
 *
 * ---------------------------------------------------------------------------
 * [중요] 이미 계정이 시딩된 DB라면 — career_interest 백필이 필요하다
 * ---------------------------------------------------------------------------
 * career_interest 는 ADR 0003(학생 홈 계열 매칭)에서 뒤늦게 추가된 필드다. 로그인 기능 완료 시점
 * (커밋 d93ca2a)에 이 스크립트를 이미 실행했다면 profiles 6행이 career_interest = NULL 로 들어있고,
 * 위 "재실행 = 즉시 중단" 동작 때문에 이 스크립트로는 값을 채울 수 없다. profiles 에 update 정책이
 * 0개이고 계열 선택 UI(마이페이지 스펙)도 없어서 앱에서 넣을 방법도 없다.
 *
 * 그 상태로 두면 학생 홈이 100% 최신순 fallback 으로만 동작하고 "내 관심 계열" 배지가 한 장도
 * 뜨지 않는다. 에러 없이 조용히 그렇게 되므로(부제만 "새로 등록된 프로그램을 모아봤어요"로 바뀜)
 * 화면만 봐서는 정상 동작과 구별되지 않는다.
 *
 * 해결: 계정을 지우고 재시딩할 필요 없이, Supabase SQL Editor 에서 아래를 1회 실행하면 된다.
 *   update public.profiles set career_interest = 'it'  where code = '10718';
 *   update public.profiles set career_interest = 'sci' where code = '10719';
 *   update public.profiles set career_interest = 'hum' where code = '10720';
 *   update public.profiles set career_interest = 'biz' where code = '10721';
 *   -- 10722(최하은), ADM-0001(정하윤)은 NULL 유지 — 의도된 fallback 시연 / 관리자는 계열 개념 없음
 *
 * 값은 아래 DEMO_ACCOUNTS 와 반드시 일치해야 한다(둘 다 ADR 0003 "시드 설계" 표가 출처).
 * 신규 프로젝트에 처음 실행하는 경우에는 이 백필이 필요 없다 — 아래 insert 가 값을 함께 넣는다.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// .env.seed 로더
// 외부 dotenv 의존성 없이 최소 구현 (주석 #, 빈 줄, 앞뒤 따옴표만 처리하는 단순 파서).
// 이미 process.env에 값이 있으면(예: CI에서 export) 덮어쓰지 않는다.
// ---------------------------------------------------------------------------
function loadEnvSeedFile() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(scriptDir, '..', '.env.seed');

  if (!existsSync(envPath)) {
    console.warn(
      `[경고] ${envPath} 파일을 찾을 수 없습니다. 셸에 SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY를 ` +
        '이미 export 했다면 무시해도 됩니다. 그렇지 않다면 .env.seed.example을 복사해 채워주세요.'
    );
    return;
  }

  const content = readFileSync(envPath, 'utf-8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    const isQuoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (isQuoted) value = value.slice(1, -1);

    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvSeedFile();

// ---------------------------------------------------------------------------
// 가상 이메일 변환 규칙 (ADR 0002)
//   buildVirtualEmail(code) = code.trim().toLowerCase() + '@accumu.local'
//
// 주의(드리프트 방지): 이 로직의 단일 소스는 원래 src/lib/virtualEmail.js로 지정되어 있으나
// (ADR 0001 폴더 구조, ADR 0002), 이 스크립트를 작성하는 시점에는 아직 프런트엔드
// 프로젝트(Vite)가 스캐폴딩되지 않아 그 파일이 존재하지 않는다. 그래서 우선 로컬에 동일 로직을
// 복제해둔다. frontend-agent가 src/lib/virtualEmail.js를 만들고 나면, 이 함수를
// `import { buildVirtualEmail } from '../src/lib/virtualEmail.js'`로 교체해 이중 구현을 없앨 것.
// ---------------------------------------------------------------------------
function buildVirtualEmail(code) {
  return `${code.trim().toLowerCase()}@accumu.local`;
}

// ---------------------------------------------------------------------------
// 확정된 데모 계정
// 단일 출처: docs/specs/auth-login.md의 "확정된 데모 계정" 표.
// 표가 바뀌면 이 배열도 함께 수정한다.
//
// career_interest (ADR 0003 "시드 설계", 2026-07-16 케빈 확정)
//   - 값 공간은 career_track enum 5종(sci/it/hum/biz/art). 오타는 profiles insert 시점에 거부된다.
//   - [왜 시딩이 유일한 입력 경로인가] 계열 선택 UI는 마이페이지 스펙(이번 스코프 아님)이고,
//     profiles 에 update 정책이 0개라 앱에서 저장할 방법 자체가 없다. 시딩하지 않으면 학생 홈은
//     100% 최신순 fallback 으로만 동작해 인수 조건("계열 일치 항목이 앞에 오고 배지가 붙는다")을
//     검증할 수 없다.
//   - 10718(주 데모 계정)은 it. 시드 프로그램에 it 계열이 가장 많다(scripts/seed-programs.mjs).
//   - 10722는 의도적으로 null — 계열 미설정 학생의 최신순 fallback 경로(확정 E의 빈 값 분기) 시연용.
//   - admin(ADM-0001)은 계열 개념 자체가 없어 null. DB CHECK로 강제하지 않고 이 스크립트의 책임으로 둔다
//     (mentor_students 의 role 정합성을 트리거로 강제하지 않은 ADR 0002 판단과 동일).
// ---------------------------------------------------------------------------
const DEMO_PASSWORD = 'accumu2026';

const DEMO_ACCOUNTS = [
  { role: 'student', code: '10718', name: '신지훈', career_interest: 'it' },
  { role: 'student', code: '10719', name: '김도윤', career_interest: 'sci' },
  { role: 'student', code: '10720', name: '이서연', career_interest: 'hum' },
  { role: 'student', code: '10721', name: '박민준', career_interest: 'biz' },
  { role: 'student', code: '10722', name: '최하은', career_interest: null },
  { role: 'admin', code: 'ADM-0001', name: '정하윤', career_interest: null },
];

async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      '[오류] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다. ' +
        '.env.seed.example을 복사해 .env.seed를 만들고 값을 채워주세요.'
    );
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const studentIds = [];
  let adminId = null;

  for (const account of DEMO_ACCOUNTS) {
    const email = buildVirtualEmail(account.code);

    const trackLabel = account.career_interest ?? '계열 없음';
    console.log(
      `[생성] ${account.role} ${account.code} (${account.name}, ${trackLabel}) -> ${email}`
    );

    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email,
      password: DEMO_PASSWORD,
      email_confirm: true,
    });

    if (createError) {
      console.error(`[중단] auth 계정 생성 실패 (${account.code}): ${createError.message}`);
      process.exit(1);
    }

    const userId = created.user.id;

    const { error: profileError } = await supabase.from('profiles').insert({
      id: userId,
      role: account.role,
      code: account.code,
      name: account.name,
      career_interest: account.career_interest, // null 허용 (10722, 관리자). ADR 0003.
    });

    if (profileError) {
      console.error(`[중단] profiles insert 실패 (${account.code}): ${profileError.message}`);
      process.exit(1);
    }

    if (account.role === 'student') {
      studentIds.push(userId);
    } else {
      adminId = userId;
    }
  }

  if (!adminId) {
    console.error('[중단] 관리자 계정이 생성되지 않았습니다. DEMO_ACCOUNTS 구성을 확인해주세요.');
    process.exit(1);
  }

  const mentorRows = studentIds.map((studentId) => ({
    admin_id: adminId,
    student_id: studentId,
  }));

  console.log(
    `[생성] mentor_students 매핑 ${mentorRows.length}건 (관리자 1명 -> 학생 ${mentorRows.length}명)`
  );

  const { error: mentorError } = await supabase.from('mentor_students').insert(mentorRows);

  if (mentorError) {
    console.error(`[중단] mentor_students insert 실패: ${mentorError.message}`);
    process.exit(1);
  }

  console.log('완료: 데모 계정 6개(학생 5 + 관리자 1) 및 mentor_students 매핑 생성됨.');
  console.log('로그인 확인: 학번/관리자코드 + 비밀번호 accumu2026 (docs/specs/auth-login.md 표 참고)');
  console.log('다음 단계: node seed-programs.mjs (데모 프로그램 시딩)');
}

main().catch((err) => {
  console.error('[예외 발생]', err);
  process.exit(1);
});
