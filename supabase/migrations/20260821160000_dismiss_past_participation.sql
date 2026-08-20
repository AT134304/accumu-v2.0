-- Accumu v2 — 끝난 활동을 QR 목록에서 지운다 (ADR 0025)
--
-- [배경 — 케빈, 2026-08-20]
--   "기간 끝나면 입장 QR 탭에서 아예 사라지게 해줘. 아니면 삭제 버튼을 만들어준다거나."
--
--   QR 센터는 "완료되지 않은 내 참여"를 전부 보여준다. 그래서 신청만 하고 안 간 활동, 입장만 하고
--   퇴장을 안 찍은 활동이 **영원히 목록에 남는다.** 단일 일자 프로그램이면 날짜가 한참 지났는데도
--   '입장 QR' 버튼이 그대로 눌리는 상태가 된다(서버는 거부하지만 화면은 권한다).
--
--   취소(cancel_my_participation, ADR 0016)로는 지울 수 없다 — 그 함수는 "시작 전날까지"만 받는다.
--   즉 **지난 참여를 정리할 경로가 아예 없었다.**
--
-- [화면 쪽 처리는 두 갈래다 — QrCenterModal]
--   (1) 끝난 활동은 기본 목록에서 빠지고 "지난 활동 N건" 접이식으로 내려간다 (사라지게 해달라는 요청)
--   (2) 그 안에서 "목록에서 지우기"를 누르면 이 함수가 행을 실제로 지운다 (삭제 버튼 요청)
--   >>> 접기만 하고 끝내지 않은 이유: 숨기는 것은 화면의 일이라 다음 기기·다음 로그인에서 되돌아온다.
--       지우려면 서버가 지워야 하고, 무엇을 지워도 되는지는 서버가 정해야 한다.
--
-- [실행 순서] 20260821140000 이후(순서상 뒤일 뿐 의존하지 않는다).

-- =========================================================
-- dismiss_my_participation(p_participation_id uuid)
--
-- [★ 왜 delete 정책이 아니라 RPC 인가]
--   participations 에는 delete 정책이 0개이고 그 상태를 유지한다. "지울 수 있는 행"의 조건이
--   (내 것) + (프로그램이 끝났다) + (포인트가 지급되지 않았다) 세 가지인데, 뒤의 둘은 **다른 테이블을
--   봐야** 판정된다. 정책 using 절로도 쓸 수 있지만, 그러면 조건이 조용히 어긋났을 때 "삭제가 그냥
--   안 된다"로만 나타난다. 함수는 사유를 돌려줄 수 있다.
--
-- [★ 포인트가 지급된 참여는 지우지 않는다 — 원장 정합성]
--   기간제 per_session 모드는 status 가 completed 가 되기 전에도 회차마다 포인트를 준다.
--   그 행을 지우면 point_transactions 가 cascade 로 함께 사라지는데 profiles.points_balance 는
--   그대로 남아 **잔액과 원장이 어긋난다.** schema.sql 이 programs 에 delete 를 열지 않은 이유와
--   정확히 같은 위험이다.
--   >>> 이 조건을 빼지 말 것. 빼면 "지우기 한 번에 포인트가 공짜로 남는" 경로가 열린다.
--
-- [completed 는 대상이 아니다] 완료 활동은 아카이브이자 포트폴리오의 내용물이다. 애초에 QR 목록에
--   나오지도 않는다.
--
-- [대기열 승격을 하지 않는다] cancel_my_participation 은 자리를 비우며 다음 대기자를 올린다.
--   여기서는 **이미 끝난 프로그램**이라 승격시킬 자리가 의미를 갖지 않는다 — 끝난 활동에 사람을
--   밀어 넣으면 그 학생은 참여할 수 없는 확정 자리를 받는다.
--
-- [알림도 함께 지운다] 'exit_due'(퇴장 인증 미완료) 같은 알림이 남아 있으면, 목록에서 사라진 활동을
--   가리키는 알림만 떠다닌다. 그 프로그램에 대한 내 알림을 같이 지운다.
-- =========================================================
create or replace function public.dismiss_my_participation(p_participation_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_student uuid := auth.uid();
  v_p       public.participations%rowtype;
  v_prog    public.programs%rowtype;
begin
  if v_student is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;

  select * into v_p
    from public.participations
   where id = p_participation_id
   for update;

  if not found or v_p.student_id <> v_student then
    -- 없는 행과 남의 행을 구분해 알려주지 않는다(존재 여부를 캐내는 데 쓰이지 않도록).
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_p.status = 'completed' then
    return jsonb_build_object('ok', false, 'reason', 'completed');
  end if;

  select * into v_prog from public.programs where id = v_p.program_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- 상시 진행(튜토리얼)은 끝나지 않는다 — ADR 0021.
  if coalesce(v_prog.is_tutorial, false) then
    return jsonb_build_object('ok', false, 'reason', 'not_over');
  end if;

  if coalesce(v_prog.end_date, v_prog.date) >= public.today_kst() then
    return jsonb_build_object('ok', false, 'reason', 'not_over');
  end if;

  -- 포인트가 한 번이라도 지급됐으면 지우지 않는다(위 설명).
  if exists (
    select 1 from public.point_transactions t
     where t.related_participation_id = v_p.id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'has_points');
  end if;

  -- 이 활동을 가리키던 내 알림도 함께 정리한다.
  delete from public.notifications
   where student_id = v_student
     and program_id = v_p.program_id;

  -- attendance_sessions 는 on delete cascade 로 함께 사라진다(20260809140000).
  delete from public.participations where id = v_p.id;

  return jsonb_build_object('ok', true);
end;
$$;

comment on function public.dismiss_my_participation(uuid) is
  '[ADR 0025] 끝난 프로그램의 내 참여 행을 지운다(QR 센터의 "목록에서 지우기"). '
  '조건: 내 것 + completed 아님 + 프로그램이 끝남(coalesce(end_date,date) < 오늘, 튜토리얼 제외) + 포인트 미지급. '
  '[포인트 조건을 빼지 말 것] 지급된 원장이 cascade 로 사라지면 profiles.points_balance 와 어긋난다. '
  '[대기열 승격을 하지 않는다] 끝난 프로그램에는 넘겨줄 자리가 없다 — cancel_my_participation 과 다른 지점이다.';

revoke all on function public.dismiss_my_participation(uuid) from public;
grant execute on function public.dismiss_my_participation(uuid) to authenticated;

-- =========================================================
-- 적용 후 확인 (학생 세션)
--   1) 지난 날짜 프로그램에 applied 로 남은 참여 -> {"ok": true}, QR 목록에서 사라진다
--   2) 오늘/미래 프로그램 -> {"ok": false, "reason": "not_over"}
--   3) 남의 참여 id -> {"ok": false, "reason": "not_found"}
--   4) 튜토리얼 참여 -> {"ok": false, "reason": "not_over"}
--   5) 포인트가 지급된 기간제 참여 -> {"ok": false, "reason": "has_points"}
-- =========================================================
