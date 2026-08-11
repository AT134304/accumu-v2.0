-- Accumu v2 — 신규 학생용 튜토리얼 프로그램 (ADR 0021)
--
-- [배경] 케빈 요청(2026-08-11): "처음 이 프로그램에 가입했을 때 학생들을 위한 간단한 튜토리얼...
--   임시 프로그램을 만들어 이름은 'Accumu 사용법 알아보기', 기간은 무기한, 학생당 딱 한 번만 신청
--   가능. 신청하면 QR 인증을 하는데 관리자 스캔 없이 자동으로 인식 완료되고, 아카이브 기록·포인트
--   지급까지 실제 흐름과 동일하게."
--
-- [설계 원칙 — 기존 흐름을 최대한 재사용한다] 아카이브(참여 status='completed'로 조회) · 만족도
--   평가(퇴장 인증 완료 시 자동 노출) · 포인트 지급(point_transactions + profiles 잔액)은 전부
--   기존 코드가 이미 처리한다. 이 마이그레이션이 새로 만드는 것은 딱 두 가지다:
--   1) 그 프로그램 자체(무기한·1인 1회를 만족하는 데이터), 2) 관리자 스캔을 거치지 않고 학생 본인이
--   자기 QR을 직접 검증하는 새 RPC. verify_participation_qr()(관리자 전용, ADR 0005)은 한 글자도
--   바꾸지 않는다 — 별도 함수로 완전히 분리해야 "관리자만 진짜 참여를 인증한다"는 원칙 5의 핵심을
--   실수로 넓히지 않는다.
--
-- [무기한을 어떻게 표현하는가 — DB가 아니라 프런트가 판정한다] programs.date는 not null이라 "날짜 없음"을
--   표현할 컬럼이 없다. 대신 is_tutorial=true인 프로그램은 프런트가 "지난 날짜" 판정(확정 H-1)에서
--   제외하고 "상시 진행"으로 표시한다 — date 컬럼 값 자체는 오늘 날짜로 채워 두지만 의미가 없다
--   (표시·신청 가능 여부 어디에도 이 값이 쓰이지 않는다).
-- [1인 1회는 이미 있는 제약으로 공짜로 성립한다] participations에 (student_id, program_id) unique가
--   있어 같은 프로그램에 두 번째 참여 행을 만들 수 없다 — 새 제약이 필요 없다.
-- [admin 화면에 안 뜨는 이유] created_by를 NULL로 둔다. AdminProgramsPage/AdminHomePage는 전부
--   `created_by = 내 id`로 필터하므로, NULL은 어느 관리자의 목록에도 절대 걸리지 않는다 — 실수로
--   수정·게시중단되는 사고를 원천적으로 막는다("일부러 열어둔 문"이 아니라 "존재하지 않는 문").

-- =========================================================
-- 1. programs.is_tutorial
-- =========================================================
alter table public.programs add column if not exists is_tutorial boolean not null default false;

-- 시스템이 소유하는 프로그램은 최대 1개뿐이어야 한다 — 실수로 두 번째 튜토리얼이 생기는 것을 막는다.
create unique index if not exists programs_single_tutorial_idx
  on public.programs ((true))
  where is_tutorial;

comment on column public.programs.is_tutorial is
  '[ADR 0021] true면 신규 학생 온보딩용 시스템 프로그램이다. 관리자 편집 폼(ProgramFormModal)의
   컬럼 화이트리스트(FORM_COLUMNS)에 없으므로 관리자가 이 값을 직접 켜거나 끌 수 없다 — 앱에서
   이 값이 true인 행은 이 마이그레이션이 심은 것 하나뿐이다. date/end_date의 "지난 날짜" 판정에서
   제외되고(프런트, 확정 H-1 예외), QR 인증은 관리자 스캔이 아니라 verify_tutorial_qr()로 학생
   본인이 완료한다.';

-- =========================================================
-- 2. 튜토리얼 프로그램 시드
--
-- [멱등] is_tutorial=true 행이 이미 있으면 다시 넣지 않는다 — 재실행해도 안전하다.
-- [career_track/category — 임의 선택임을 명시] 실제 진로 활동이 아니라 이 카테고리·계열의 의미가
--   없다. CLAUDE.md가 "기타 칸을 만들지 말 것"을 못박아 뒀으므로 새 분류를 만드는 대신 기존 4종 중
--   가장 가까운 'school'(교내 활동)을 쓴다 — 계열은 추천 매칭에만 쓰이는 값이라 아무 값이나 골라도
--   기능에 영향이 없다('hum'을 골랐다).
-- [points=150 — 최소값] programs_points_rule 제약(CLAUDE.md 7장)이 150 미만을 막는다. 실제 활동과
--   같은 규칙을 그대로 적용해 "이 값만 특별하다"는 예외를 만들지 않는다.
-- =========================================================
insert into public.programs (
  category, title, description, org, date, time, capacity, points, career_track,
  popularity, status, is_published, created_by, is_tutorial
)
select
  'school', 'Accumu 사용법 알아보기',
  'Accumu를 처음 쓰는 학생을 위한 연습용 활동입니다. 신청부터 QR 입·퇴장 인증, 포인트 적립, ' ||
    '디지털 아카이브 기록까지 실제 활동과 똑같은 흐름을 그대로 체험할 수 있어요. QR 인증은 ' ||
    '카메라 스캔 없이 자동으로 완료됩니다.',
  'Accumu', current_date, '상시', null, 150, 'hum',
  999999, 'open', true, null, true
where not exists (select 1 from public.programs where is_tutorial);

-- =========================================================
-- 3. verify_tutorial_qr() — 학생 본인의 튜토리얼 QR 셀프 검증
--
-- [verify_participation_qr()와 다른 점 딱 둘]
--   (a) 호출 자격: is_admin() 대신 "이 참여 건의 student_id = auth.uid()". 학생 본인만, 자기 것만.
--   (b) 대상 제한: programs.created_by = 호출자 대신 programs.is_tutorial = true. 이 한 줄이
--       진짜 방어선이다 — 없으면 학생이 실제 프로그램의 토큰을 이 함수에 넣어 관리자 스캔 없이
--       무단으로 자기 참여를 완료시키고 포인트를 받아 갈 수 있다(원칙 5 정면 위반).
--   나머지(entry/exit CAS 전이, 만료 검사, 포인트 지급 트랜잭션)는 원본과 완전히 동일한 로직이다 —
--   따로 함수를 둔 이유가 "관리자 전용 함수의 방어선을 조건문으로 느슨하게 만들지 않기" 위해서라,
--   로직 자체는 검증된 그대로 복제한다.
-- =========================================================
create or replace function public.verify_tutorial_qr(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_student uuid := auth.uid();
  v_token   text;
  v_kind    text;
  v_p       public.participations%rowtype;
  v_prog    public.programs%rowtype;
  v_base    jsonb;
  v_rows    integer;
  v_points  integer;
  v_now     timestamptz := now();
begin
  if v_student is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;

  v_token := public.qr_normalize_token(p_token);
  if length(v_token) <> 10 then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select * into v_p from public.participations where entry_token = v_token for update;
  if found then
    v_kind := 'entry';
  else
    select * into v_p from public.participations where exit_token = v_token for update;
    if found then
      v_kind := 'exit';
    end if;
  end if;

  if v_kind is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- [경계 (a)] 본인 참여 건이 아니면 존재 자체를 알려주지 않는다(관리자 함수의 "존재 노출 금지"와 같은 원칙).
  if v_p.student_id <> v_student then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- [경계 (b) — 진짜 방어선] 튜토리얼 프로그램이 아니면 절대 통과시키지 않는다.
  select * into v_prog from public.programs where id = v_p.program_id;
  if not found or v_prog.is_tutorial is not true then
    return jsonb_build_object('ok', false, 'reason', 'not_tutorial');
  end if;

  v_base := jsonb_build_object('type', v_kind, 'program_title', v_prog.title);

  if v_p.status = 'completed' then
    return v_base || jsonb_build_object('ok', false, 'reason', 'already_completed');
  end if;

  if v_kind = 'entry' then
    if v_p.status <> 'applied' then
      return v_base || jsonb_build_object('ok', false, 'reason', 'used');
    end if;
    if v_p.entry_token_expires_at is null or v_p.entry_token_expires_at <= v_now then
      return v_base || jsonb_build_object('ok', false, 'reason', 'expired');
    end if;

    update public.participations
       set status = 'entered', entry_at = v_now
     where id = v_p.id
       and status = 'applied';
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      return v_base || jsonb_build_object('ok', false, 'reason', 'used');
    end if;

    return v_base || jsonb_build_object('ok', true, 'reason', null, 'at', v_now);
  end if;

  -- v_kind = 'exit'
  if v_p.status = 'applied' then
    return v_base || jsonb_build_object('ok', false, 'reason', 'wrong_order');
  end if;
  if v_p.exit_token_expires_at is null or v_p.exit_token_expires_at <= v_now then
    return v_base || jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  v_points := v_prog.points;

  begin
    update public.participations
       set status = 'completed', exit_at = v_now
     where id = v_p.id
       and status = 'entered';
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      return v_base || jsonb_build_object('ok', false, 'reason', 'already_completed');
    end if;

    insert into public.point_transactions (student_id, type, amount, related_participation_id)
    values (v_p.student_id, '적립', v_points, v_p.id);

    update public.profiles
       set points_balance = points_balance + v_points,
           points_total   = points_total   + v_points
     where id = v_p.student_id;
  exception
    when unique_violation then
      return v_base || jsonb_build_object('ok', false, 'reason', 'already_completed');
  end;

  return v_base || jsonb_build_object('ok', true, 'reason', null, 'points_awarded', v_points, 'at', v_now);
end;
$$;

comment on function public.verify_tutorial_qr(text) is
  '[ADR 0021] 튜토리얼 프로그램 전용 셀프 QR 검증. 학생 본인이 관리자 스캔 없이 자기 입·퇴장을
   완료한다. verify_participation_qr()(관리자 전용, ADR 0005)과 로직은 동일하지만 자격 검사가
   다르다 — 호출자가 본인 참여 건인지, 그 프로그램이 programs.is_tutorial=true인지만 확인한다.
   이 두 번째 검사가 유일한 방어선이다: 없으면 학생이 실제 프로그램의 토큰으로 이 함수를 불러
   무단 자가 인증 + 부정 적립을 할 수 있다. 퇴장 시 포인트 지급은 verify_participation_qr()과
   완전히 같은 트랜잭션 구조(CAS + unique 2차 방어)를 쓴다.';

revoke all on function public.verify_tutorial_qr(text) from public;
grant execute on function public.verify_tutorial_qr(text) to authenticated;

-- =========================================================
-- 적용 후 확인
--   1) 학생 계정으로 'Accumu 사용법 알아보기' 신청 -> 입장 QR 발급 -> verify_tutorial_qr(그 토큰) 호출
--      -> {ok:true, type:'entry'}, participations.status='entered'
--   2) 퇴장 QR 발급 -> verify_tutorial_qr(그 토큰) -> {ok:true, points_awarded:150}, status='completed',
--      profiles.points_balance/points_total 150 증가, point_transactions에 행 1개
--   3) 실제(튜토리얼 아닌) 프로그램의 참여 건 토큰으로 verify_tutorial_qr() 호출 -> {ok:false, reason:'not_tutorial'}
--   4) 남의 튜토리얼 참여 토큰으로 호출 -> {ok:false, reason:'not_found'} (내 것이 아니면 존재도 안 알려줌)
--   5) 같은 학생이 튜토리얼에 두 번째로 신청 시도 -> 기존 applyToProgram()의 'duplicate' 그대로
-- =========================================================
