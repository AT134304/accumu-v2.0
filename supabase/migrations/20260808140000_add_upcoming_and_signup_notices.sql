-- Accumu v2 — 알림 3종 추가 + 담당 학생 알림을 두 경로로 구분 (ADR 0013 후속)
--
-- [케빈 확정 — 2026-08-08]
--   추가: upcoming(학생 내일 참여 예정) / upcoming_admin(관리자 내일 진행 예정) / exit_due(퇴장 인증 미완료)
--   제외: 정원 마감(인원수를 노출해야 해서 ADR 0013 결정 3 과 충돌) / 초대코드 연동 실패(이벤트가 없다)
--   보강: mentee 알림이 "가입으로 추가"와 "연동으로 추가"를 구분한다
--
-- [★ 새로 만든 알림이 전부 지연 계산인 이유]
--   "내일이다" / "일정이 지났는데 퇴장을 안 했다" 는 **사건이 아니라 시간이 지나면 참이 되는 상태**다.
--   트리거는 행이 바뀔 때만 깨어나므로 아무도 건드리지 않는 행에서는 영원히 발화하지 않는다.
--   ADR 0012 settle_my_points() / ADR 0013 결정 4 와 같은 판단 — 답이 날짜의 함수라 언제 계산해도
--   같으므로 화면이 열릴 때 계산한다. pg_cron 을 켜지 않는다.
--
-- [★ 알려진 열화 — 지연 계산의 대가]
--   'upcoming' 은 **그 하루 동안 앱을 한 번이라도 열어야** 생긴다. 전날 앱을 안 열면 그 알림은
--   영영 만들어지지 않는다(다음 날에는 date = 내일 조건이 이미 거짓이다).
--   푸시 알림이 스코프 밖이라(CLAUDE.md 11장) 이건 구조적 한계이고, 감수한다.
--   >>> 이걸 메우려고 pg_cron 을 켜지 말 것. 시연에서 확인할 수 없는 실패 지점이 는다.
--
-- [선행 조건] **20260808100000 → 20260808140000 순서로 실행할 것.**
--   이 파일은 새 enum 값(upcoming/upcoming_admin/exit_due)이 이미 커밋돼 있다고 가정한다.
--   재실행해도 안전하다.

-- =========================================================
-- 1. 타입 확장 — **이 파일에 없다. 20260808100000 이 소유한다.**
--
-- [★ 여기 두면 반드시 실패한다] Postgres 는 같은 트랜잭션에서 추가한 enum 값을 그 트랜잭션 안에서
--   쓰는 것을 금지한다(55P04). Supabase SQL Editor 는 스크립트 전체를 한 트랜잭션으로 실행하고,
--   아래 2번 절의 부분 인덱스 술어(where type in ('stale', ...))가 정확히 그 "사용"이다.
--   재실행도 통하지 않는다 — 오류가 트랜잭션을 되돌리며 alter type 까지 함께 취소한다.
--   >>> alter type ... add value 를 이 파일에 되돌려 놓지 말 것.
-- =========================================================

-- =========================================================
-- 2. 멱등 인덱스 — "수신자 x 프로그램 x 종류" 당 1회
--
-- ADR 0013 은 stale 전용 부분 인덱스를 만들었다. 같은 성격의 알림이 셋 더 늘었으므로 type 을 키에
-- 포함한 하나로 합친다(stale 전용 인덱스는 이 인덱스에 포함되므로 지운다).
--
-- [조건문으로 "이미 있나"를 세지 않는 이유] 동시 요청 두 건이 같은 검사를 통과하는 창이 생긴다.
--   insert ... on conflict do nothing 이 그 창을 없앤다.
-- [event 성 알림(new/apply/enter/exit/convert/mentee)은 이 인덱스에 걸리지 않는다] 그것들은 사건마다
--   1행이 정상이다. 예: 같은 프로그램에 입장/퇴장 알림이 각각 있어야 한다.
-- =========================================================
drop index if exists public.notifications_stale_once_idx;

create unique index if not exists notifications_once_per_program_idx
  on public.notifications (recipient_id, program_id, type)
  where type in ('stale', 'upcoming', 'upcoming_admin', 'exit_due');

-- =========================================================
-- 3. mentee 알림 — "가입으로 추가" vs "연동으로 추가"
--
-- mentor_students 행이 생기는 앱 경로는 정확히 둘이고(CLAUDE.md 5장), 둘 다 이 트리거를 지난다:
--   (a) 학교 계정 가입      — handle_new_user() 안에서 profiles + mentor_students 를 함께 만든다
--   (b) 마이페이지 초대코드 — link_school_account() 가 기존 학생에 매핑만 더한다
--
-- [두 경로를 무엇으로 구분하는가 — 정확한 판정이다]
--   now() 는 **트랜잭션 시작 시각**이라 한 트랜잭션 안에서 고정이다. (a)에서는 profiles.created_at 과
--   mentor_students.created_at 이 같은 트랜잭션의 default now() 라 **정확히 같은 값**이 된다.
--   (b)에서는 프로필이 이전 트랜잭션에서 만들어졌으므로 절대 같을 수 없다.
--   >>> "몇 초 이내" 같은 어림짐작이 아니다. 이 등식을 시간 범위 비교로 바꾸지 말 것.
--
-- [★ 알림 실패가 가입을 되돌리면 안 된다]
--   (a) 경로에서 이 트리거는 auth.users insert 와 같은 트랜잭션에 있다. 여기서 예외가 나면
--   **가입 전체가 롤백된다.** 알림 한 건 때문에 회원가입이 실패하는 것은 명백히 잘못된 우선순위다.
--   그래서 이 트리거는 예외를 삼킨다 — 이 저장소에서 예외를 삼키는 거의 유일한 자리이며,
--   삼키는 대상이 "부가 통지"이고 지키는 것이 "가입"이라서 정당하다.
--   >>> 권한/정합성 검사를 이 블록 안으로 옮기지 말 것. 삼켜지면 안 되는 것이 함께 삼켜진다.
-- =========================================================
create or replace function public.notifications_on_mentor_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name     text;
  v_created  timestamptz;
  v_message  text;
  v_detail   text;
begin
  begin
    select pr.name, pr.created_at
      into v_name, v_created
      from public.profiles pr
     where pr.id = new.student_id;

    v_name := coalesce(v_name, '학생');

    if v_created = new.created_at then
      -- (a) 학교 계정으로 가입하면서 담당에 들어왔다
      v_message := '새 학생이 학교 계정으로 가입했어요';
      v_detail  := v_name || ' 님이 내 초대코드로 가입해 담당 학생이 되었어요';
    else
      -- (b) 이미 있던 개인 계정 학생이 마이페이지에서 초대코드를 입력했다
      v_message := '담당 학생이 추가되었어요';
      v_detail  := v_name || ' 님이 내 학교 초대코드로 연동했어요';
    end if;

    perform public.notify_user(new.admin_id, 'mentee', v_message, v_detail, null);
  exception
    when others then
      -- 위 [★] 참고. 가입/연동은 계속 진행된다.
      raise warning '[notifications_on_mentor_link] 알림 생성 실패 (가입/연동은 정상 처리): %', sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists notifications_on_mentor_link_insert on public.mentor_students;
create trigger notifications_on_mentor_link_insert
  after insert on public.mentor_students
  for each row execute function public.notifications_on_mentor_link();

-- =========================================================
-- 4. sync_my_notices() — 상태형 알림 한 곳에서 (구 sync_stale_program_notices)
--
-- [RPC 권한 경계] sync_my_notices()
--   호출 가능: authenticated. 본문에서 로그인 여부를 검사한다.
--   허용 대상: auth.uid() 본인이 만든 프로그램 / 본인의 참여뿐. 인자가 0개라 남을 훑을 경로가 없다.
--   쓰는 컬럼: notifications 만. programs / participations 는 읽기만 한다.
--   불가능: 남의 알림 생성(경로 없음), 중복 알림(위 부분 unique 인덱스), anon 호출(42501)
--
-- [★ security definer 라 RLS 가 우회된다 — 모든 where 절에 v_me 가 반드시 있어야 한다]
--   아래 4개 insert 는 전부 created_by = v_me 또는 student_id = v_me 로 묶여 있다.
--   이 조건을 지우면 그 순간 "전교생 알림 생성기"가 된다.
--
-- [역할로 갈라지지만 함수는 하나다] 화면이 부르는 이름이 하나여야 학생 셸과 관리자 셸이 같은 호출을
--   공유한다. 역할 판정은 서버가 한다(프런트가 role 을 보고 함수를 고르면 그것도 클라이언트 판정이다).
--
-- [★ 알리기만 한다] programs / participations 를 update 하지 않는다.
--   게시 상태는 관리자의 내리기 토글이, 참여 상태는 QR 검증이 유일한 경로다.
-- =========================================================
drop function if exists public.sync_stale_program_notices();

create or replace function public.sync_my_notices()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me       uuid := auth.uid();
  v_today    date;
  v_tomorrow date;
  v_total    integer := 0;
  v_n        integer;
begin
  if v_me is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  -- 날짜 기준은 KST. programs.date 는 date 컬럼이라 그 자체가 한국 달력의 날짜다.
  v_today    := (now() at time zone 'Asia/Seoul')::date;
  v_tomorrow := v_today + 1;

  if public.is_admin() then
    -- (1) stale — 일정이 지났는데 아직 게시중 (ADR 0013 결정 4, 동작 그대로)
    insert into public.notifications (recipient_id, type, message, detail, program_id)
    select p.created_by, 'stale', '일정이 지난 프로그램이 있어요',
           p.title || ' · ' || to_char(p.date, 'MM월 DD일') || ' 종료 · 내려도 괜찮아요',
           p.id
      from public.programs p
     where p.created_by = v_me
       and p.is_published = true
       and p.date < v_today
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;

    -- (2) upcoming_admin — 내일 진행. "QR 스캔 준비" 는 관리자 기능 3종 안의 사실이다(원칙 6).
    insert into public.notifications (recipient_id, type, message, detail, program_id)
    select p.created_by, 'upcoming_admin', '내일 진행하는 프로그램이 있어요',
           p.title || coalesce(' · ' || p.time, '') || ' · QR 스캔을 준비해 주세요',
           p.id
      from public.programs p
     where p.created_by = v_me
       and p.is_published = true
       and p.date = v_tomorrow
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;

  else
    -- (3) upcoming — 내일 참여 예정. 아직 입장 전(applied)인 건만.
    insert into public.notifications (recipient_id, type, message, detail, program_id)
    select pa.student_id, 'upcoming', '내일 참여 예정 활동이 있어요',
           p.title || coalesce(' · ' || p.time, ''),
           p.id
      from public.participations pa
      join public.programs p on p.id = pa.program_id
     where pa.student_id = v_me
       and pa.status = 'applied'
       and p.date = v_tomorrow
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;

    -- (4) exit_due — 입장은 했는데 퇴장 인증이 없다. 그 상태로는 포인트가 지급되지 않는다.
    --     [원칙 5 를 깎지 않는다] 알림은 "남아 있다"고 알릴 뿐 퇴장을 대신 처리하지 않는다.
    --     퇴장은 여전히 관리자 QR 스캔만이 완료시킨다.
    --     [원칙 4] 제목은 인증 이야기이고 포인트는 부가 줄이다.
    insert into public.notifications (recipient_id, type, message, detail, program_id)
    select pa.student_id, 'exit_due', '퇴장 인증이 남아 있어요',
           p.title || ' · 퇴장 인증을 마치면 포인트가 적립돼요',
           p.id
      from public.participations pa
      join public.programs p on p.id = pa.program_id
     where pa.student_id = v_me
       and pa.status = 'entered'
       and p.date < v_today
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
  end if;

  return v_total;
end;
$$;

comment on function public.sync_my_notices() is
  '[ADR 0013] 상태형 알림을 한 곳에서 만든다. 관리자: stale(일정 지난 게시중) + upcoming_admin(내일 진행). '
  '학생: upcoming(내일 참여 예정) + exit_due(퇴장 인증 미완료). '
  '[트리거가 아닌 이유] "내일이다"/"지났다" 는 사건이 아니라 시간이 지나면 참이 되는 상태라 트리거가 '
  '깨어날 계기가 없다. 답이 날짜의 함수라 화면이 열릴 때 계산한다(pg_cron 을 켜지 않는다). '
  '[멱등] notifications_once_per_program_idx + on conflict do nothing. '
  '[알리기만 한다] programs/participations 를 update 하지 않는다. '
  '[★ definer 라 RLS 우회 — 모든 where 절의 v_me 조건을 지우지 말 것] 지우면 전교생 알림 생성기가 된다. '
  '[알려진 열화] upcoming 은 그 하루 안에 앱을 열어야 생긴다(푸시는 스코프 밖 — CLAUDE.md 11장).';

revoke all on function public.sync_my_notices() from public;
grant execute on function public.sync_my_notices() to authenticated;

-- =========================================================
-- 시연 리셋 (참고)
--   delete from public.notifications;
--   -- 상태형 알림은 다음 화면 진입 때 다시 만들어진다(멱등이라 지워도 안전하다).
-- =========================================================
