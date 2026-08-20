/**
 * Accumu v2 — RLS 회귀 테스트 (2026-08-20)
 *
 * [왜 만들었나]
 *   이 프로젝트의 권한 경계는 전부 DB 안에 있다(RLS 정책 + security definer 함수). 그런데 그 경계가
 *   실제로 막히는지는 지금까지 **문서와 손 확인**으로만 검증됐다. 정책은 한 줄만 어긋나도 조용히
 *   열리고, 조용히 열린 것은 화면을 보는 것으로는 절대 발견되지 않는다 — 화면은 원래 그 데이터를
 *   안 그리기 때문이다.
 *   >>> 그래서 "금지된 요청을 실제로 쏴서 전부 막히는지" 확인한다. 통과가 아니라 **거부**를 기대하는
 *       테스트가 대부분인 이유다.
 *
 * [무엇을 검증하지 않나]
 *   화면·UX·반응형은 대상이 아니다. 여기서 보는 것은 오직 "anon / 학생 / 관리자 키로 무엇을 할 수
 *   있고 없는가" 하나다.
 *
 * [실행]
 *   node scripts/test-rls.mjs
 *   node scripts/test-rls.mjs --cleanup   # 앞선 실행이 중간에 죽어 남은 테스트 데이터만 지운다
 *
 * [환경변수] .env.seed 와 .env.local 을 둘 다 읽는다(둘 중 있는 값을 쓴다).
 *   SUPABASE_URL                 (또는 VITE_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY    — 테스트 계정 생성/정리에만 쓴다. 검증 요청에는 쓰지 않는다.
 *   SUPABASE_ANON_KEY            (또는 VITE_SUPABASE_ANON_KEY) — 검증 요청은 전부 이 키로 나간다.
 *
 * [★ 검증 요청에 service_role 을 쓰지 않는다] 그 키는 RLS 를 통째로 우회한다. 그 키로 테스트하면
 *   모든 테스트가 통과하고 아무것도 검증하지 않는다. service_role 의 용도는 아래 두 가지뿐이다:
 *     (1) 테스트용 계정·프로그램 만들기  (2) 끝나고 지우기
 *
 * [안전성] 만드는 데이터는 전부 제목/이름에 마커('[RLS-TEST]', 'RLSTEST-')가 붙는다. 끝나면 finally
 *   에서 지우고, 중간에 죽어도 --cleanup 으로 같은 조건으로 지울 수 있다. 시드 계정·기존 프로그램은
 *   읽지도 건드리지도 않는다.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// .env 로더 — seed 스크립트의 관례를 따라 자기완결적으로 둔다(scripts/lib/ 추출은 4개째부터).
// 이미 process.env 에 값이 있으면 덮어쓰지 않는다.
// ---------------------------------------------------------------------------
function loadEnvFiles() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const file of ['.env.seed', '.env.local']) {
    const p = path.join(root, file);
    if (!existsSync(p)) continue;
    for (const rawLine of readFileSync(p, 'utf-8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  }
}
loadEnvFiles();

const URL_ = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!URL_ || !SERVICE_KEY || !ANON_KEY) {
  console.error(
    '[중단] 환경변수가 부족합니다. 필요한 값:\n' +
      '  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (.env.seed)\n' +
      '  VITE_SUPABASE_ANON_KEY                    (.env.local)'
  );
  process.exit(1);
}

const MARK = '[RLS-TEST]';
const CODE_PREFIX = 'RLSTEST-';
const PW = 'rls-test-2026!';
// [★ 날짜는 KST 로 만든다] 서버의 today_kst() 와 같은 기준이어야 한다. UTC 로 만들면 UTC 15:00~24:00
//   (KST 오전 0~9시) 구간에서 하루가 어긋나, "오늘" 프로그램이 서버에겐 "어제"가 되면서 수정 잠금
//   테스트가 시간대에 따라 통과했다 실패했다 한다.
const kstDate = (offsetDays = 0) =>
  new Date(Date.now() + 9 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
const TODAY = kstDate(0);
const YESTERDAY = kstDate(-1);

// 신고 이유용 긴 문장 생성 (ADR 0026: 공개 150자 / 참여자 80자).
// [정확한 길이로 자른다] 경계값(149/150)을 테스트해야 하는데 대충 길게 쓰면 무엇을 검증하는지 흐려진다.
const FILLER = '공고에 적힌 내용과 실제 진행이 어떻게 달랐는지 구체적으로 적은 신고 사유입니다. ';
const detailOf = (n) => FILLER.repeat(Math.ceil(n / FILLER.length)).slice(0, n);

const sr = createClient(URL_, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const anon = () => createClient(URL_, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// ---------------------------------------------------------------------------
// 테스트 하네스
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [32mPASS[0m  ${name}`);
  } catch (e) {
    failures.push({ name, message: e?.message ?? String(e) });
    console.log(`  [31mFAIL[0m  ${name}\n         ${e?.message ?? e}`);
  }
}

function group(title) {
  console.log(`\n[1m${title}[0m`);
}

/** select 결과의 행 수가 기대와 같은지. RLS 로 막힌 select 는 에러가 아니라 **0행**으로 온다. */
async function expectRows(query, n, hint = '') {
  const { data, error } = await query;
  if (error) throw new Error(`쿼리가 에러로 끝났다(0행을 기대했다면 이것도 실패다): ${error.code} ${error.message}`);
  const got = (data ?? []).length;
  if (got !== n) throw new Error(`${n}행을 기대했는데 ${got}행이 왔다. ${hint}`);
}

/** insert/update 가 지정한 코드로 거부되는지. 코드를 여러 개 주면 그중 하나면 통과. */
async function expectError(query, codes, hint = '') {
  const want = Array.isArray(codes) ? codes : [codes];
  const { error } = await query;
  if (!error) throw new Error(`거부(${want.join('/')})를 기대했는데 성공했다. ${hint}`);
  if (!want.includes(error.code)) {
    throw new Error(`거부 코드가 ${want.join('/')} 일 줄 알았는데 ${error.code}(${error.message}) 였다. ${hint}`);
  }
}

/** update 가 "에러 없이 0행"으로 끝나는지 — RLS using 절에 걸린 update 의 정상적인 모습이다. */
async function expectNoRowsAffected(query, hint = '') {
  const { data, error } = await query;
  if (error) throw new Error(`0행 영향을 기대했는데 에러가 왔다: ${error.code} ${error.message}. ${hint}`);
  const got = (data ?? []).length;
  if (got !== 0) throw new Error(`0행 영향을 기대했는데 ${got}행이 바뀌었다. ${hint}`);
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// 준비 / 정리
// ---------------------------------------------------------------------------
async function cleanup() {
  // [감사 로그를 먼저 치운다 — ADR 0025] admin_audit 은 programs/profiles 를 FK 로 참조하지 않아
  //   cascade 로 사라지지 않는다. 지우기 전에 대상 id 를 모아둬야 어느 행이 테스트 것인지 알 수 있다.
  //   >>> 이 정리를 빼면 테스트를 돌릴 때마다 시연용 DB 의 감사 로그가 가짜 행으로 불어난다.
  const { data: doomedProgs } = await sr.from('programs').select('id').like('title', `${MARK}%`);
  const { data: profs } = await sr.from('profiles').select('id').like('code', `${CODE_PREFIX}%`);
  const targets = [...(doomedProgs ?? []), ...(profs ?? [])].map((r) => r.id);
  if (targets.length > 0) {
    await sr.from('admin_audit').delete().in('target_id', targets);
    await sr.from('admin_audit').delete().in('actor_id', (profs ?? []).map((r) => r.id));
  }

  // 프로그램 — participations / program_reports 가 cascade 로 함께 사라진다.
  await sr.from('programs').delete().like('title', `${MARK}%`);
  for (const p of profs ?? []) {
    await sr.auth.admin.deleteUser(p.id); // profiles 는 on delete cascade
  }
  await sr.from('invite_codes').delete().like('code', `${CODE_PREFIX}%`);
}

async function makeUser({ code, role, name, school, accountType }) {
  const email = `${code.toLowerCase()}@accumu.local`;
  const { data, error } = await sr.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw new Error(`테스트 계정 생성 실패(${code}): ${error.message}`);
  const id = data.user.id;
  // metadata 를 비워 보냈으므로 handle_new_user() 는 관여하지 않는다(시딩 경로와 같다) — 직접 넣는다.
  const { error: pe } = await sr
    .from('profiles')
    .insert({ id, role, code, name, school, account_type: accountType });
  if (pe) throw new Error(`테스트 프로필 생성 실패(${code}): ${pe.message}`);
  return { id, email, code };
}

async function makeProgram({ owner, title, published, extra = {} }) {
  const { data, error } = await sr
    .from('programs')
    .insert({
      category: 'career',
      title: `${MARK} ${title}`,
      description: '권한 경계 테스트용 프로그램입니다.',
      org: '테스트기관',
      date: TODAY,
      time: '10:00–12:00',
      points: 300,
      career_track: 'eng',
      is_published: published,
      created_by: owner,
      ...extra,
    })
    .select('id')
    .single();
  if (error) throw new Error(`테스트 프로그램 생성 실패(${title}): ${error.message}`);
  return data.id;
}

/** anon 키 클라이언트로 로그인해서 "그 사용자의 권한을 가진" 클라이언트를 만든다. */
async function signIn(email) {
  const c = anon();
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`테스트 로그인 실패(${email}): ${error.message}`);
  return c;
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------
async function main() {
  if (process.argv.includes('--cleanup')) {
    await cleanup();
    console.log('테스트 데이터를 정리했습니다.');
    return;
  }

  console.log(`대상: ${URL_}`);
  console.log('준비 중… (테스트 계정 4개 + 프로그램 3개)');
  await cleanup(); // 앞선 실행의 잔여물 제거

  const admA = await makeUser({
    code: `${CODE_PREFIX}ADMA`, role: 'admin', name: '테스트관리자A', school: '테스트고', accountType: null,
  });
  const admB = await makeUser({
    code: `${CODE_PREFIX}ADMB`, role: 'admin', name: '테스트관리자B', school: '테스트고', accountType: null,
  });
  const stuA = await makeUser({
    code: `${CODE_PREFIX}STUA`, role: 'student', name: '테스트학생A', school: '테스트고', accountType: 'school',
  });
  const stuB = await makeUser({
    code: `${CODE_PREFIX}STUB`, role: 'student', name: '테스트학생B', school: null, accountType: 'personal',
  });

  const stuC = await makeUser({
    code: `${CODE_PREFIX}STUC`, role: 'student', name: '테스트학생C', school: null, accountType: 'personal',
  });

  await sr.from('mentor_students').insert({ admin_id: admA.id, student_id: stuA.id });

  const progA = await makeProgram({ owner: admA.id, title: 'A의 공개 프로그램', published: true });
  const progADraft = await makeProgram({ owner: admA.id, title: 'A의 미게시 초안', published: false });
  const progB = await makeProgram({ owner: admB.id, title: 'B의 공개 프로그램', published: true });
  // 끝난 프로그램(어제) — 수정 잠금 / 활동 정리 테스트용.
  const progPast = await makeProgram({
    owner: admA.id, title: 'A의 끝난 프로그램', published: true, extra: { date: YESTERDAY },
  });
  // 신고 임계치 테스트 전용. 자동 게시중단이 일어나므로 다른 테스트와 섞지 않는다.
  const progReport = await makeProgram({ owner: admB.id, title: 'B의 신고 대상', published: true });

  // 학생 A 가 A의 프로그램에 신청 (QR 테스트의 재료)
  const { data: part, error: partErr } = await sr
    .from('participations')
    .insert({ student_id: stuA.id, program_id: progA })
    .select('id')
    .single();
  if (partErr) throw new Error(`테스트 참여 생성 실패: ${partErr.message}`);

  // 끝난 프로그램에 남은 참여(no-show) — "목록에서 지우기" 테스트의 재료.
  const { data: pastPart, error: pastErr } = await sr
    .from('participations')
    .insert({ student_id: stuB.id, program_id: progPast })
    .select('id')
    .single();
  if (pastErr) throw new Error(`테스트 참여(지난) 생성 실패: ${pastErr.message}`);

  const cAnon = anon();
  const cStuA = await signIn(stuA.email);
  const cStuB = await signIn(stuB.email);
  const cStuC = await signIn(stuC.email);
  const cAdmA = await signIn(admA.email);
  const cAdmB = await signIn(admB.email);

  try {
    // =====================================================================
    group('1. anon (로그인 없음) — 아무것도 읽거나 쓸 수 없어야 한다');
    // =====================================================================
    await t('anon 은 profiles 를 못 읽는다', () => expectRows(cAnon.from('profiles').select('id'), 0));
    await t('anon 은 게시된 programs 도 못 읽는다 (정책이 to authenticated)', () =>
      expectRows(cAnon.from('programs').select('id'), 0));
    await t('anon 은 participations 를 못 읽는다', () =>
      expectRows(cAnon.from('participations').select('id'), 0));
    await t('anon 은 invite_codes 를 못 읽는다', () =>
      expectRows(cAnon.from('invite_codes').select('code'), 0));
    await t('anon 은 point_transactions 를 못 읽는다', () =>
      expectRows(cAnon.from('point_transactions').select('id'), 0));
    await t('anon 은 programs 를 못 만든다', () =>
      expectError(
        cAnon.from('programs').insert({
          category: 'career', title: `${MARK} anon`, description: 'x', org: 'x',
          date: TODAY, time: '1', points: 300, career_track: 'eng',
        }),
        ['42501']
      ));
    await t('anon 은 QR 검증 함수를 못 부른다', async () => {
      const { error } = await cAnon.rpc('verify_participation_qr', { p_token: 'AAAAAAAAAA' });
      expect(error, '거부를 기대했는데 통과했다');
    });
    await t('anon 은 정산 함수를 못 부른다', async () => {
      const { error } = await cAnon.rpc('settle_my_points');
      expect(error, '거부를 기대했는데 통과했다');
    });

    // =====================================================================
    group('2. 가입 사전검증 oracle — 20260820120000 의 핵심 회귀');
    // =====================================================================
    await t('★ 관리자 초대코드의 정오답을 더 이상 알려주지 않는다', async () => {
      const { data, error } = await cAnon.rpc('check_signup_availability', {
        p_role: 'admin', p_code: `${CODE_PREFIX}NEWADM`, p_invite: 'ADMIN-완전히틀린값',
      });
      expect(!error, `에러: ${error?.message}`);
      expect(data?.ok === true, `틀린 관리자 코드에도 ok:true 여야 한다(판정은 가입 시점). 받은 값: ${JSON.stringify(data)}`);
    });
    await t('학교 초대코드는 여전히 검사한다(가입 UX 유지)', async () => {
      const { data } = await cAnon.rpc('check_signup_availability', {
        p_role: 'student', p_code: `${CODE_PREFIX}NEWSTU`, p_invite: 'SCH-00000000',
      });
      expect(data?.reason === 'invalid_school_invite', `invalid_school_invite 를 기대했다. 받은 값: ${JSON.stringify(data)}`);
    });
    await t('이미 쓰는 코드는 code_taken 으로 막는다', async () => {
      const { data } = await cAnon.rpc('check_signup_availability', {
        p_role: 'student', p_code: stuA.code, p_invite: null,
      });
      expect(data?.reason === 'code_taken', `code_taken 을 기대했다. 받은 값: ${JSON.stringify(data)}`);
    });
    await t('★ 학교 초대코드가 관리자 uuid 에서 유도되지 않는다 (md5 규칙 폐기)', async () => {
      const { data } = await sr.from('invite_codes').select('code, admin_id').eq('kind', 'school').limit(20);
      expect((data ?? []).length > 0, 'school 초대코드가 하나도 없다 — 마이그레이션을 확인할 것');
      const { createHash } = await import('node:crypto');
      for (const row of data) {
        const legacy = 'SCH-' + createHash('md5').update(row.admin_id).digest('hex').slice(0, 4).toUpperCase();
        expect(
          row.code !== legacy,
          `${row.code} 가 md5(관리자 uuid) 로 그대로 계산된다 — 20260820120000 이 적용되지 않았다. ` +
            '관리자 uuid 는 대표 사진 공개 URL 에 들어 있어 학생이 읽을 수 있다.'
        );
      }
    });

    // =====================================================================
    group('3. 학생 — 남의 것도, 자기 것의 금지된 컬럼도 만질 수 없어야 한다');
    // =====================================================================
    await t('학생은 자기 프로필을 읽는다', () =>
      expectRows(cStuA.from('profiles').select('id').eq('id', stuA.id), 1));
    await t('학생은 다른 학생의 프로필을 못 읽는다', () =>
      expectRows(cStuA.from('profiles').select('id').eq('id', stuB.id), 0));
    await t('학생은 관리자 프로필을 못 읽는다', () =>
      expectRows(cStuA.from('profiles').select('id').eq('id', admA.id), 0));
    await t('학생은 미게시 프로그램을 못 읽는다', () =>
      expectRows(cStuA.from('programs').select('id').eq('id', progADraft), 0));
    await t('학생은 게시 프로그램은 읽는다', () =>
      expectRows(cStuA.from('programs').select('id').eq('id', progA), 1));
    await t('학생은 programs 를 못 만든다 (자기 프로그램에 자기가 신청하는 폐루프 차단)', () =>
      expectError(
        cStuA.from('programs').insert({
          category: 'career', title: `${MARK} 학생작성`, description: 'x', org: 'x',
          date: TODAY, time: '1', points: 3000, career_track: 'eng', created_by: stuA.id,
        }),
        ['42501']
      ));
    await t('학생은 programs 를 못 고친다', () =>
      expectNoRowsAffected(cStuA.from('programs').update({ points: 3000 }).eq('id', progA).select('id')));
    await t('학생은 mentor_students 를 못 읽는다 (자기 멘토가 누구인지도 모른다)', () =>
      expectRows(cStuA.from('mentor_students').select('admin_id'), 0));
    await t('학생은 invite_codes 를 못 읽는다', () =>
      expectRows(cStuA.from('invite_codes').select('code'), 0));
    await t('학생은 남의 참여 기록을 못 읽는다', () =>
      expectRows(cStuB.from('participations').select('id').eq('id', part.id), 0));
    await t('학생은 남의 이름으로 참여를 못 만든다', () =>
      expectError(
        cStuB.from('participations').insert({ student_id: stuA.id, program_id: progB }),
        ['42501']
      ));
    await t('학생은 참여에 QR 토큰을 미리 심을 수 없다', () =>
      expectError(
        cStuB.from('participations').insert({ student_id: stuB.id, program_id: progB, entry_token: 'ABCDEFGHIJ' }),
        ['42501', '42601', 'PGRST204']
      ));
    await t('학생은 자기 참여 상태를 직접 바꿀 수 없다 (update 정책 0개)', () =>
      expectNoRowsAffected(
        cStuA.from('participations').update({ status: 'completed' }).eq('id', part.id).select('id')
      ));
    await t('학생은 포인트 원장을 직접 못 만든다', () =>
      expectError(
        cStuA.from('point_transactions').insert({ student_id: stuA.id, type: '적립', amount: 3000 }),
        ['42501']
      ));
    await t('학생은 자기 포인트 잔액을 직접 못 올린다', () =>
      expectNoRowsAffected(
        cStuA.from('profiles').update({ points_balance: 999999 }).eq('id', stuA.id).select('id')
      ));
    await t('학생은 미게시 프로그램에 신청할 수 없다', () =>
      expectError(
        cStuB.from('participations').insert({ student_id: stuB.id, program_id: progADraft }),
        ['42501']
      ));
    await t('학생은 QR 검증(관리자 전용)을 못 부른다', async () => {
      const { error } = await cStuA.rpc('verify_participation_qr', { p_token: 'AAAAAAAAAA' });
      expect(error?.code === '42501', `42501 을 기대했다. 받은 값: ${error?.code} ${error?.message}`);
    });
    await t('학생의 정산 함수는 인자가 0개이고 정상 동작한다', async () => {
      const { error } = await cStuA.rpc('settle_my_points');
      expect(!error, `에러: ${error?.code} ${error?.message}`);
    });

    // =====================================================================
    group('4. 관리자 — 축 A(내 프로그램) / 축 B(내 담당 학생) 밖으로 못 나간다');
    // =====================================================================
    await t('관리자는 자기 미게시 초안을 읽는다', () =>
      expectRows(cAdmA.from('programs').select('id').eq('id', progADraft), 1));
    await t('관리자는 다른 관리자의 미게시 초안을 못 읽는다', async () => {
      const draftB = await makeProgram({ owner: admB.id, title: 'B의 초안', published: false });
      await expectRows(cAdmA.from('programs').select('id').eq('id', draftB), 0);
    });
    await t('관리자는 다른 관리자의 프로그램을 못 고친다', () =>
      expectNoRowsAffected(cAdmA.from('programs').update({ points: 3000 }).eq('id', progB).select('id')));
    await t('관리자는 소유권을 남에게 넘길 수 없다', () =>
      expectNoRowsAffected(
        cAdmA.from('programs').update({ created_by: admB.id }).eq('id', progA).select('id')
      ));
    await t('관리자는 프로그램을 지울 수 없다 (delete 정책 0개)', () =>
      expectNoRowsAffected(cAdmA.from('programs').delete().eq('id', progA).select('id')));
    await t('관리자는 담당 학생의 프로필을 읽는다', () =>
      expectRows(cAdmA.from('profiles').select('id').eq('id', stuA.id), 1));
    await t('관리자는 담당이 아닌 학생의 프로필을 못 읽는다', () =>
      expectRows(cAdmA.from('profiles').select('id').eq('id', stuB.id), 0));
    await t('관리자 B 는 관리자 A 의 담당 학생을 못 읽는다', () =>
      expectRows(cAdmB.from('profiles').select('id').eq('id', stuA.id), 0));
    await t('관리자 B 는 관리자 A 의 담당 매핑을 못 읽는다', () =>
      expectRows(cAdmB.from('mentor_students').select('student_id').eq('student_id', stuA.id), 0));
    await t('관리자는 초대코드를 만들 수 없다 (관리자 무한 증식 차단)', () =>
      expectError(
        cAdmA.from('invite_codes').insert({ code: `${CODE_PREFIX}FAKE`, kind: 'admin', admin_id: null }),
        ['42501']
      ));
    await t('관리자는 참여 기록을 만들 수 없다 (자기 프로그램에 자기를 꽂는 경로 차단)', () =>
      expectError(
        cAdmA.from('participations').insert({ student_id: stuA.id, program_id: progA }),
        ['42501']
      ));

    // =====================================================================
    group('5. 프로그램 입력 검증 — 20260820140000 (폼을 우회한 요청)');
    // =====================================================================
    const base = {
      category: 'career', description: '설명', org: '기관', date: TODAY, time: '10:00',
      points: 300, career_track: 'eng', created_by: admA.id,
    };
    await t('★ 공백만 있는 제목은 거부된다', () =>
      expectError(cAdmA.from('programs').insert({ ...base, title: '   ' }), ['23514']));
    await t('★ 80자를 넘는 제목은 거부된다', () =>
      expectError(cAdmA.from('programs').insert({ ...base, title: '가'.repeat(81) }), ['23514']));
    await t('★ 400자를 넘는 설명은 거부된다', () =>
      expectError(
        cAdmA.from('programs').insert({ ...base, title: `${MARK} 긴설명`, description: '가'.repeat(401) }),
        ['23514']
      ));
    await t('★ 공백만 있는 주최는 거부된다', () =>
      expectError(cAdmA.from('programs').insert({ ...base, title: `${MARK} 빈주최`, org: ' ' }), ['23514']));
    await t('★ 공백만 있는 시간은 거부된다', () =>
      expectError(cAdmA.from('programs').insert({ ...base, title: `${MARK} 빈시간`, time: ' ' }), ['23514']));
    await t('★ 20억짜리 정원은 거부된다', () =>
      expectError(
        cAdmA.from('programs').insert({ ...base, title: `${MARK} 큰정원`, capacity: 2000000000 }),
        ['23514']
      ));
    await t('★ 2999년 날짜는 거부된다', () =>
      expectError(
        cAdmA.from('programs').insert({ ...base, title: `${MARK} 먼미래`, date: '2999-01-01' }),
        ['23514']
      ));
    await t('포인트 규칙(150~3000, 끝자리 0)은 그대로 살아 있다', () =>
      expectError(cAdmA.from('programs').insert({ ...base, title: `${MARK} 포인트`, points: 3333 }), ['23514']));
    await t('외부 주소 사진은 거부된다', () =>
      expectError(
        cAdmA.from('programs').insert({ ...base, title: `${MARK} 외부사진`, image_url: 'https://evil.example.com/x.png' }),
        ['23514']
      ));
    await t('★ 다른 관리자 폴더의 사진은 참조할 수 없다', () => {
      const host = new URL(URL_).host;
      const foreign = `https://${host}/storage/v1/object/public/program-images/${admB.id}/x.webp`;
      return expectError(
        cAdmA.from('programs').insert({ ...base, title: `${MARK} 남의사진`, image_url: foreign }),
        ['42501']
      );
    });
    await t('정상 값은 그대로 저장된다 (회귀 확인)', async () => {
      const { error } = await cAdmA
        .from('programs')
        .insert({ ...base, title: `${MARK} 정상 등록`, is_published: false });
      expect(!error, `정상 등록이 막히면 안 된다: ${error?.code} ${error?.message}`);
    });

    // =====================================================================
    group('6. QR 토큰 상태 기계');
    // =====================================================================
    let token = null;
    await t('학생은 자기 참여의 입장 QR 을 발급받는다 (토큰 10자)', async () => {
      const { data, error } = await cStuA.rpc('issue_participation_qr', {
        p_participation_id: part.id, p_type: 'entry',
      });
      expect(!error, `에러: ${error?.code} ${error?.message}`);
      token = data?.token;
      expect(typeof token === 'string' && token.length === 10, `토큰 10자를 기대했다. 받은 값: ${JSON.stringify(data)}`);
    });
    await t('학생은 남의 참여로 QR 을 발급받을 수 없다', async () => {
      const { data, error } = await cStuB.rpc('issue_participation_qr', {
        p_participation_id: part.id, p_type: 'entry',
      });
      expect(error || !data?.token, `거부를 기대했다. 받은 값: ${JSON.stringify(data)}`);
    });
    await t('★ 다른 관리자는 그 토큰을 인증할 수 없다 (내가 올린 프로그램만)', async () => {
      const { data, error } = await cAdmB.rpc('verify_participation_qr', { p_token: token });
      expect(!error, `에러: ${error?.message}`);
      expect(data?.reason === 'not_authorized', `not_authorized 를 기대했다. 받은 값: ${JSON.stringify(data)}`);
    });
    await t('없는 토큰은 not_found', async () => {
      const { data } = await cAdmA.rpc('verify_participation_qr', { p_token: 'ZZZZZZZZZZ' });
      expect(data?.reason === 'not_found', `not_found 를 기대했다. 받은 값: ${JSON.stringify(data)}`);
    });
    await t('프로그램 주인 관리자는 인증에 성공한다', async () => {
      const { data } = await cAdmA.rpc('verify_participation_qr', { p_token: token });
      expect(data?.ok === true, `ok:true 를 기대했다. 받은 값: ${JSON.stringify(data)}`);
    });
    await t('★ 같은 토큰을 두 번 쓸 수 없다 (1회용)', async () => {
      const { data } = await cAdmA.rpc('verify_participation_qr', { p_token: token });
      expect(data?.ok === false, `두 번째는 거부여야 한다. 받은 값: ${JSON.stringify(data)}`);
      expect(data?.reason === 'used', `used 를 기대했다. 받은 값: ${JSON.stringify(data)}`);
    });
    await t('입장 전에는 퇴장 토큰을 발급받을 수 없던 순서가 유지된다 (지금은 entered 라 발급된다)', async () => {
      const { data, error } = await cStuA.rpc('issue_participation_qr', {
        p_participation_id: part.id, p_type: 'exit',
      });
      expect(!error, `에러: ${error?.message}`);
      expect(typeof data?.token === 'string', `입장을 마쳤으므로 퇴장 토큰이 나와야 한다. 받은 값: ${JSON.stringify(data)}`);
    });

    // =====================================================================
    group('7. 끝난 프로그램 수정 잠금 — ADR 0025 / 20260821120000');
    // =====================================================================
    await t('★ 끝난 프로그램의 내용은 수정할 수 없다', () =>
      expectError(
        cAdmA.from('programs').update({ title: `${MARK} 바뀐 제목` }).eq('id', progPast).select('id'),
        ['22023']
      ));
    await t('★ 끝난 프로그램도 게시 상태는 바꿀 수 있다 (stale 알림이 요구하는 행동)', async () => {
      const { data, error } = await cAdmA
        .from('programs')
        .update({ is_published: false })
        .eq('id', progPast)
        .select('id');
      expect(!error, `내리기는 통과해야 한다: ${error?.code} ${error?.message}`);
      expect((data ?? []).length === 1, '1행이 바뀌어야 한다');
      // [되돌리지 않는다 — ADR 0026] 이제 false -> true 는 publish_my_program() 만 할 수 있고,
      //   끝난 프로그램은 그 함수가 'over' 로 거부한다. 뒤의 테스트도 이 프로그램의 게시 상태에
      //   의존하지 않는다(dismiss_my_participation 은 정책이 아니라 행을 직접 읽는다).
    });
    await t('★ 날짜를 미래로 밀어 잠금을 푸는 우회가 막힌다 (판정은 OLD 기준)', () =>
      expectError(
        cAdmA.from('programs').update({ date: TODAY }).eq('id', progPast).select('id'),
        ['22023']
      ));
    await t('진행 중/예정 프로그램은 그대로 수정된다 (회귀 확인)', async () => {
      const { error } = await cAdmA
        .from('programs')
        .update({ org: '테스트기관2' })
        .eq('id', progA)
        .select('id');
      expect(!error, `정상 수정이 막히면 안 된다: ${error?.code} ${error?.message}`);
    });

    // =====================================================================
    group('8. 한줄평 길이 — 상한 60 폐기, 하한 20 신설 (ADR 0025)');
    // =====================================================================
    // 리뷰는 completed 참여에만 달 수 있다. 위 6번에서 입장까지 갔으니 퇴장까지 마쳐 완료로 만든다.
    await t('퇴장 인증까지 마치면 참여가 완료된다 (리뷰 전제 조건)', async () => {
      const { data: issued } = await cStuA.rpc('issue_participation_qr', {
        p_participation_id: part.id,
        p_type: 'exit',
      });
      const { data } = await cAdmA.rpc('verify_participation_qr', { p_token: issued?.token });
      expect(data?.ok === true, `퇴장 인증이 성공해야 한다. 받은 값: ${JSON.stringify(data)}`);
    });
    await t('★ 19자 한줄평은 거부된다', () =>
      expectError(
        cStuA.from('reviews').insert({ participation_id: part.id, rating: 5, comment: '가'.repeat(19) }),
        ['23514']
      ));
    await t('★ 501자 한줄평은 거부된다', () =>
      expectError(
        cStuA.from('reviews').insert({ participation_id: part.id, rating: 5, comment: '가'.repeat(501) }),
        ['23514']
      ));
    await t('★ 공백만 있는 한줄평은 거부된다 (btrim 기준)', () =>
      expectError(
        cStuA.from('reviews').insert({ participation_id: part.id, rating: 5, comment: ' '.repeat(30) }),
        ['23514']
      ));
    await t('한줄평 없이(null) 별점만 저장된다 — 여전히 선택 항목이다', async () => {
      const { error } = await cStuA
        .from('reviews')
        .insert({ participation_id: part.id, rating: 4, comment: null });
      expect(!error, `별점만 저장이 막히면 안 된다: ${error?.code} ${error?.message}`);
    });
    await t('★ 60자 한줄평이 이제 저장된다 (옛 상한이 풀렸다)', async () => {
      const { data, error } = await cStuA
        .from('reviews')
        .update({ comment: '가'.repeat(60) })
        .eq('participation_id', part.id)
        .select('id');
      expect(!error, `에러: ${error?.code} ${error?.message}`);
      expect((data ?? []).length === 1, '1행이 바뀌어야 한다');
    });

    // =====================================================================
    group('9. 학생 신고 → 자동 게시중단 (ADR 0025)');
    // =====================================================================
    await t('학생은 신고 테이블에 남의 이름으로 쓸 수 없다', () =>
      expectError(
        cStuA.from('program_reports').insert({
          program_id: progReport,
          student_id: stuB.id,
          reason: 'not_real',
          // 제약이 아니라 **정책**에 걸려야 하는 테스트다 — 두 분류의 하한을 모두 넘겨서 42501 을 확인한다.
          detail: detailOf(160),
        }),
        ['42501']
      ));
    await t('★ 관리자는 신고할 수 없다 (관리자끼리의 무기가 되지 않게)', async () => {
      const { error } = await cAdmA.rpc('report_my_program', {
        p_program_id: progReport,
        p_reason: 'not_real',
        p_detail: detailOf(160),
      });
      expect(error?.code === '42501', `42501 을 기대했다. 받은 값: ${error?.code} ${error?.message}`);
    });
    await t('★ 참여하지 않은 학생은 참여자 전용 사유(설명 불일치·시간 미준수)를 쓸 수 없다', async () => {
      for (const reason of ['mismatch', 'unpunctual']) {
        const { data } = await cStuA.rpc('report_my_program', {
          p_program_id: progReport,
          p_reason: reason,
          p_detail: detailOf(200),
        });
        expect(
          data?.reason === 'not_participant',
          `${reason}: not_participant 를 기대했다. 받은 값: ${JSON.stringify(data)}`
        );
      }
    });
    await t('★ 참여하지 않아도 공개 사유 5종은 쓸 수 있다 (자격 자체는 통과한다)', async () => {
      // 149자라 길이에서 걸린다 — "자격은 통과했고 길이만 남았다"를 이 사유로 확인한다.
      // [not_real / other 가 여기 있는 것이 2026-08-22 개정의 핵심이다]
      //   not_real 은 프로그램이 안 열린 경우라 QR 을 찍을 수 없다 — 참여자 전용으로 두면
      //   자격이 영원히 생기지 않아 아무도 못 쓰는 죽은 사유가 된다.
      for (const reason of ['irrelevant', 'paid', 'inappropriate', 'not_real', 'other']) {
        const { data } = await cStuA.rpc('report_my_program', {
          p_program_id: progReport,
          p_reason: reason,
          p_detail: detailOf(149),
        });
        expect(
          data?.reason === 'detail_length',
          `${reason}: detail_length 를 기대했다(not_participant 가 오면 분류가 틀린 것). 받은 값: ${JSON.stringify(data)}`
        );
        expect(data?.min === 150, `공개 사유 하한은 150 이어야 한다. 받은 값: ${JSON.stringify(data)}`);
      }
    });
    await t('★ 어떤 사유든 이유가 필요하다', async () => {
      const { data } = await cStuA.rpc('report_my_program', {
        p_program_id: progReport,
        p_reason: 'inappropriate',
        p_detail: null,
      });
      expect(data?.reason === 'detail_required', `detail_required 를 기대했다. 받은 값: ${JSON.stringify(data)}`);
    });
    await t('공백만 있는 이유는 거부된다 (btrim 기준)', async () => {
      const { data } = await cStuA.rpc('report_my_program', {
        p_program_id: progReport,
        p_reason: 'inappropriate',
        p_detail: ' '.repeat(200),
      });
      expect(data?.reason === 'detail_required', `detail_required 를 기대했다. 받은 값: ${JSON.stringify(data)}`);
    });
    await t('★ 참여한 학생은 참여자 전용 사유를 80자부터 쓸 수 있다', async () => {
      // 학생 A 는 위 6·8번에서 progA 에 입장·퇴장 인증을 마쳤다(status=completed).
      const short = await cStuA.rpc('report_my_program', {
        p_program_id: progA,
        p_reason: 'unpunctual',
        p_detail: detailOf(79),
      });
      expect(short.data?.reason === 'detail_length', `79자는 거부돼야 한다. 받은 값: ${JSON.stringify(short.data)}`);
      expect(short.data?.min === 80, `참여자 사유 하한은 80 이어야 한다. 받은 값: ${JSON.stringify(short.data)}`);

      const okRes = await cStuA.rpc('report_my_program', {
        p_program_id: progA,
        p_reason: 'unpunctual',
        p_detail: detailOf(80),
      });
      expect(okRes.data?.ok === true, `80자는 통과해야 한다. 받은 값: ${JSON.stringify(okRes.data)}`);
    });
    await t('신고 1건 — 아직 게시 중이다', async () => {
      const { data } = await cStuA.rpc('report_my_program', {
        p_program_id: progReport,
        p_reason: 'inappropriate',
        p_detail: detailOf(150),
      });
      expect(data?.ok === true, `접수돼야 한다. 받은 값: ${JSON.stringify(data)}`);
      const { data: prog } = await sr.from('programs').select('is_published').eq('id', progReport).single();
      expect(prog?.is_published === true, '1건으로는 내려가면 안 된다');
    });
    await t('★ 같은 학생의 두 번째 신고는 에러가 아니라 already 다', async () => {
      const { data } = await cStuA.rpc('report_my_program', {
        p_program_id: progReport,
        p_reason: 'paid',
        p_detail: detailOf(150),
      });
      expect(data?.reason === 'already', `already 를 기대했다. 받은 값: ${JSON.stringify(data)}`);
    });
    await t('신고 2건 — 아직 게시 중이다', async () => {
      await cStuB.rpc('report_my_program', {
        p_program_id: progReport,
        p_reason: 'paid',
        p_detail: detailOf(150),
      });
      const { data: prog } = await sr.from('programs').select('is_published').eq('id', progReport).single();
      expect(prog?.is_published === true, '2건으로는 내려가면 안 된다');
    });
    await t('★ 서로 다른 학생 3명이면 서버가 자동으로 게시를 중단한다', async () => {
      const { data } = await cStuC.rpc('report_my_program', {
        p_program_id: progReport,
        p_reason: 'irrelevant',
        p_detail: detailOf(150),
      });
      expect(data?.ok === true, `접수돼야 한다. 받은 값: ${JSON.stringify(data)}`);
      const { data: prog } = await sr.from('programs').select('is_published').eq('id', progReport).single();
      expect(prog?.is_published === false, '3건째에 내려가야 한다');
    });
    await t('★ 관리자 알림에 신고자·건수·사유가 담기지 않는다', async () => {
      const { data } = await sr
        .from('notifications')
        .select('type, message, detail')
        // [★ recipient_id 다] 20260808120000 에서 student_id -> recipient_id 로 바뀌었다.
        //   이 테스트도 어제는 틀린 컬럼을 봤고, 그래서 서버 함수의 같은 실수를 못 잡았다.
        .eq('recipient_id', admB.id)
        .eq('type', 'reported');
      expect((data ?? []).length === 1, `알림 1건을 기대했다. 받은 값: ${(data ?? []).length}건`);
      const blob = `${data[0].message} ${data[0].detail ?? ''}`;
      for (const leak of ['테스트학생', '3명', '실제로 열리지']) {
        expect(!blob.includes(leak), `알림 문구에 "${leak}" 이 들어가면 안 된다: ${blob}`);
      }
    });
    await t('★ 관리자는 자기 프로그램의 신고도 읽을 수 없다', () =>
      expectRows(cAdmB.from('program_reports').select('id').eq('program_id', progReport), 0));
    await t('학생은 자기가 낸 신고만 보인다', async () => {
      // stuA 는 progReport(공개 사유) + progA(참여자 사유) 2건을 냈다.
      await expectRows(cStuA.from('program_reports').select('id'), 2);
      await expectRows(cStuA.from('program_reports').select('id').eq('student_id', stuB.id), 0);
    });
    await t('신고는 취소·수정할 수 없다 (정책 0개)', async () => {
      await expectNoRowsAffected(
        cStuA.from('program_reports').delete().eq('student_id', stuA.id).select('id')
      );
      await expectNoRowsAffected(
        cStuA.from('program_reports').update({ reason: 'paid' }).eq('student_id', stuA.id).select('id')
      );
    });

    // =====================================================================
    group('10. 감사 로그 — 남되, 앱에서는 아무도 못 읽는다 (ADR 0025)');
    // =====================================================================
    await t('★ 관리자도 감사 로그를 읽을 수 없다', () =>
      expectRows(cAdmA.from('admin_audit').select('id'), 0));
    await t('★ 학생도 감사 로그를 읽을 수 없다', () =>
      expectRows(cStuA.from('admin_audit').select('id'), 0));
    await t('감사 로그에 쓸 수도 없다 (기록 위조 차단)', () =>
      expectError(
        cAdmA.from('admin_audit').insert({ action: 'fake', target_table: 'programs' }),
        ['42501']
      ));
    await t('★ 관리자의 프로그램 수정이 실제로 기록된다', async () => {
      const { data } = await sr
        .from('admin_audit')
        .select('action, actor_id, changes')
        .eq('target_id', progA)
        .eq('action', 'program_update');
      expect((data ?? []).length > 0, '7번의 org 수정이 기록돼야 한다');
      expect(data[0].actor_id === admA.id, '행위자가 관리자 A 여야 한다');
      expect(
        data[0].changes?.org?.to === '테스트기관2',
        `바뀐 값이 담겨야 한다: ${JSON.stringify(data[0].changes)}`
      );
    });
    await t('★ 서버가 스스로 내린 게시중단은 사람을 행위자로 적지 않는다', async () => {
      const { data } = await sr
        .from('admin_audit')
        .select('actor_id, action')
        .eq('target_id', progReport)
        .eq('action', 'auto_unpublish_reported');
      expect((data ?? []).length === 1, `auto_unpublish_reported 1건을 기대했다. 받은 값: ${(data ?? []).length}건`);
      expect(data[0].actor_id === null, '행위자가 NULL 이어야 한다(신고한 학생이 아니다)');
    });

    // =====================================================================
    group('11. 끝난 활동 정리 (ADR 0025)');
    // =====================================================================
    await t('★ 아직 안 끝난 활동은 지울 수 없다', async () => {
      const { data } = await cStuA.rpc('dismiss_my_participation', { p_participation_id: part.id });
      expect(data?.ok === false, `거부돼야 한다. 받은 값: ${JSON.stringify(data)}`);
    });
    await t('★ 남의 참여는 지울 수 없다 (존재 여부도 알려주지 않는다)', async () => {
      const { data } = await cStuA.rpc('dismiss_my_participation', { p_participation_id: pastPart.id });
      expect(data?.reason === 'not_found', `not_found 를 기대했다. 받은 값: ${JSON.stringify(data)}`);
    });
    await t('★ 끝난 프로그램의 내 참여는 지워진다', async () => {
      const { data } = await cStuB.rpc('dismiss_my_participation', { p_participation_id: pastPart.id });
      expect(data?.ok === true, `지워져야 한다. 받은 값: ${JSON.stringify(data)}`);
      await expectRows(cStuB.from('participations').select('id').eq('id', pastPart.id), 0);
    });


    // =====================================================================
    group('12. 게시 게이트 — 올리기는 검사를 거쳐야 한다 (ADR 0026)');
    // =====================================================================
    await t('★ 직접 update 로 게시할 수 없다 (RPC 를 거쳐야 한다)', () =>
      expectError(
        cAdmA.from('programs').update({ is_published: true }).eq('id', progADraft).select('id'),
        ['42501']
      ));
    await t('★ 설명이 짧으면 게시가 거부된다', async () => {
      const { data } = await cAdmA.rpc('publish_my_program', { p_program_id: progADraft });
      expect(data?.reason === 'too_short', `too_short 를 기대했다. 받은 값: ${JSON.stringify(data)}`);
      const { data: prog } = await sr.from('programs').select('is_published').eq('id', progADraft).single();
      expect(prog?.is_published === false, '거부됐는데 게시되면 안 된다');
    });
    await t('설명을 채우면 게시된다', async () => {
      const { error: upErr } = await cAdmA
        .from('programs')
        .update({ description: detailOf(60) })
        .eq('id', progADraft)
        .select('id');
      expect(!upErr, `설명 수정이 막히면 안 된다: ${upErr?.code} ${upErr?.message}`);

      const { data } = await cAdmA.rpc('publish_my_program', { p_program_id: progADraft });
      expect(data?.ok === true, `게시돼야 한다. 받은 값: ${JSON.stringify(data)}`);
      const { data: prog } = await sr.from('programs').select('is_published').eq('id', progADraft).single();
      expect(prog?.is_published === true, '실제로 게시돼야 한다');
    });
    await t('이미 게시중이면 already', async () => {
      const { data } = await cAdmA.rpc('publish_my_program', { p_program_id: progADraft });
      expect(data?.reason === 'already', `already 를 기대했다. 받은 값: ${JSON.stringify(data)}`);
    });
    await t('★ 진행이 끝난 프로그램은 올릴 수 없다 (내리기는 되지만 올리기는 안 된다)', async () => {
      // progPast 는 7번에서 내려둔 상태다.
      const { data } = await cAdmA.rpc('publish_my_program', { p_program_id: progPast });
      expect(data?.reason === 'over', `over 를 기대했다. 받은 값: ${JSON.stringify(data)}`);
    });
    await t('남의 프로그램은 올릴 수 없다 (존재 여부도 알려주지 않는다)', async () => {
      const { data } = await cAdmB.rpc('publish_my_program', { p_program_id: progADraft });
      expect(data?.reason === 'not_found', `not_found 를 기대했다. 받은 값: ${JSON.stringify(data)}`);
    });
    await t('학생은 게시 함수를 부를 수 없다', async () => {
      const { error } = await cStuA.rpc('publish_my_program', { p_program_id: progADraft });
      expect(error?.code === '42501', `42501 을 기대했다. 받은 값: ${error?.code} ${error?.message}`);
    });
    await t('내리기는 여전히 평범한 update 로 된다 (문턱은 올리는 쪽에만 있다)', async () => {
      const { data, error } = await cAdmA
        .from('programs')
        .update({ is_published: false })
        .eq('id', progADraft)
        .select('id');
      expect(!error, `내리기가 막히면 안 된다: ${error?.code} ${error?.message}`);
      expect((data ?? []).length === 1, '1행이 바뀌어야 한다');
    });

  } finally {
    for (const c of [cStuA, cStuB, cStuC, cAdmA, cAdmB]) {
      await c.auth.signOut().catch(() => {});
    }
    await cleanup();
  }

  // -------------------------------------------------------------------------
  console.log('\n' + '='.repeat(64));
  if (failures.length === 0) {
    console.log(`[32m전부 통과: ${passed}개[0m`);
  } else {
    console.log(`[31m실패 ${failures.length}개[0m / 통과 ${passed}개\n`);
    for (const f of failures) console.log(`  - ${f.name}\n      ${f.message}`);
  }
  console.log('='.repeat(64));
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n[치명적] 테스트를 끝까지 실행하지 못했습니다:', e?.message ?? e);
  console.error('남은 테스트 데이터를 정리합니다 (실패하면 node scripts/test-rls.mjs --cleanup).');
  await cleanup().catch(() => {});
  process.exit(1);
});
