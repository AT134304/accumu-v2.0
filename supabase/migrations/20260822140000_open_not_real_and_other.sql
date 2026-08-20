-- Accumu v2 — not_real / other 를 공개 신고로 옮긴다 (ADR 0026 개정 1)
--
-- [배경 — 케빈, 2026-08-22]
--   "실제로 열리지 않았어요는 진행이 안 된 거니까 애초에 QR 인증을 못 하네. 그건 참여 안 해도
--    가능하게 바꿔주고 기타도 그냥 열어둬."
--
-- [★ 이건 취향 조정이 아니라 설계 결함이었다]
--   ADR 0026 은 참여자 전용 사유의 자격을 `status in ('entered','completed')` 로 뒀다. 그 근거는
--   "QR 입장 인증은 관리자가 찍어 준 것이라 학생이 스스로 만들 수 없는 증거"였고, 그 자체는 옳다.
--   그런데 `not_real`(= 그 프로그램이 열리지 않았다)에 그 조건을 걸면 이렇게 된다:
--
--     프로그램이 안 열렸다  ->  관리자가 없다  ->  QR 을 찍어 줄 사람이 없다
--                          ->  status 가 영원히 applied
--                          ->  "안 열렸다"를 신고할 자격이 영원히 생기지 않는다
--
--   즉 **논리적으로 아무도 쓸 수 없는 사유**였다. 신고 목록에 있지만 누르면 언제나 거부되는 항목.
--
-- [★ 그래서 분류 기준을 다시 세운다 — 이 파일에서 바뀌는 진짜 내용]
--   전(ADR 0026): "공고 텍스트만 보고 판단할 수 있는가"
--   후(지금)    : **"참여 인증(QR)이 실제로 남을 수 있는 종류의 일인가"**
--
--     mismatch(설명과 다름) / unpunctual(시간 미준수)
--       -> 그 자리에 **있었어야** 아는 일이고, 있었으면 QR 이 찍혔다. 참여자 전용이 성립한다.
--     not_real(안 열림)
--       -> 갔더라도 QR 을 찍을 수 없다. 참여자 전용으로 두면 사유가 죽는다.
--     irrelevant / paid / inappropriate
--       -> 공고만 봐도 안다.
--     other(기타)
--       -> 정의상 무엇인지 미리 알 수 없다. 자격을 좁힐 근거가 없다.
--
--   >>> 규칙: **참여자 전용으로 둘 수 있는 사유는, 참여가 실제로 인증됐을 때만 발생하는 사유뿐이다.**
--   >>> 새 사유를 추가할 때 이 질문을 먼저 할 것 — "이 일이 일어나면 QR 이 찍혀 있는가?"
--
-- [other 를 여는 것의 대가와 그 대가가 괜찮은 이유]
--   ADR 0026 은 other 를 참여자 전용에 두며 "공개로 두면 참여자 전용 사유를 기타로 우회하는 구멍이
--   된다"고 적었다. 그 우려 자체는 사라지지 않는다. 다만 이제 우회가 **더 비싸다**:
--     기타로 우회 = 공개 하한 150자   /   정직하게 unpunctual = 참여자 하한 80자
--   구멍이라기보다 값비싼 우회로다. 그리고 참여자 전용이 2종으로 줄어 우회할 표면 자체가 작아졌다.
--
-- [실행 순서] 20260822120000 이후. 이 파일 하나만 실행하면 된다.

-- =========================================================
-- 1. 분류 함수 재정의
--
-- [★ 이 함수 하나만 바꾸면 서버 전체가 따라온다]
--   report_my_program() 의 자격 판정과 최소 길이(v_min), CHECK 제약의 하한이 전부 이 함수를 부른다.
--   ADR 0026 이 "분류의 소유자는 이 함수 하나"라고 못박아 둔 덕분에 여기만 고치면 된다 —
--   case 문이 세 군데에 복사돼 있었다면 오늘 셋 다 고쳐야 했고, 하나를 빠뜨렸을 것이다.
--   >>> 그러니 이번에도 복사하지 말 것.
-- =========================================================
create or replace function public.report_reason_scope(p_reason public.report_reason)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_reason
    -- 참여 인증(QR)이 남을 수 있는 일. 그 자리에 있었어야 알 수 있고, 있었으면 인증이 찍혔다.
    when 'mismatch'   then 'participant'
    when 'unpunctual' then 'participant'
    -- 나머지는 전부 공개다. 공고만 봐도 알거나(irrelevant/paid/inappropriate),
    -- QR 이 찍힐 수 없거나(not_real), 미리 성격을 알 수 없다(other).
    else 'open'
  end;
$$;

comment on function public.report_reason_scope(public.report_reason) is
  '[ADR 0026 개정 1 / 2026-08-22] 신고 사유의 신고 자격. participant=참여한 학생만(mismatch, unpunctual), '
  'open=누구나(그 외 전부). '
  '[기준] "참여 인증(QR)이 실제로 남을 수 있는 종류의 일인가". not_real(안 열림)은 갔더라도 QR 을 찍을 수 '
  '없어서 참여자 전용으로 두면 아무도 쓸 수 없는 죽은 사유가 된다 — 실제로 그랬고 그래서 옮겼다. '
  '>>> 이 함수가 분류의 유일한 소유자다. case 문을 다른 곳에 복사하지 말 것.';

-- =========================================================
-- 2. 제약 재검증
--
-- [함수만 바꿔도 새 행에는 새 규칙이 적용된다] CHECK 식이 이 함수를 호출하는 형태라 그렇다.
--   그럼에도 drop/add 하는 이유는 **기존 행까지 새 규칙으로 한 번 훑기 위해서**다.
--   그냥 두면 "제약은 150자를 요구하는데 80자짜리 not_real 행이 남아 있는" 상태가 조용히 성립한다.
--
-- [정리 delete 를 먼저 두는 이유] 20260822120000 에서 배운 것 그대로 — add constraint 는 전체를
--   스캔하므로 위반 행이 하나라도 있으면 마이그레이션이 통째로 롤백된다.
--   (지금 위반 가능성이 있는 것은 하한이 80 -> 150 으로 올라간 not_real / other 행뿐이다.
--    둘 다 직전까지 참여자 전용이라 접수 자체가 거의 없었을 것이고, 재실행하면 0행이 지워진다.)
--   >>> 기준은 ADR 0026 "마이그레이션에서 걸린 것" 절: 본인 기록이면 유예, 남에게 영향을 주면 삭제.
--       신고는 후자다.
-- =========================================================
delete from public.program_reports
 where char_length(btrim(detail))
       < case when public.report_reason_scope(reason) = 'open' then 150 else 80 end
    or char_length(btrim(detail)) > 500;

alter table public.program_reports
  drop constraint if exists program_reports_detail_shape;

alter table public.program_reports
  add constraint program_reports_detail_shape
  check (
    char_length(btrim(detail)) <= 500
    and char_length(btrim(detail)) >=
        case when public.report_reason_scope(reason) = 'open' then 150 else 80 end
  );

comment on constraint program_reports_detail_shape on public.program_reports is
  '[ADR 0026] 신고 이유는 필수이며 공백 제외 500자 이하. 하한은 사유 분류에 따라 다르다 — '
  '공개(누구나) 150자 / 참여자 전용(mismatch, unpunctual) 80자. '
  '신고의 비용 = 진입장벽 + 글자 수이고, 두 신고는 장벽이 달라서다. '
  '>>> 공개 하한을 낮추지 말 것. 참여하지 않고 누르는 신고의 유일한 비용이다.';

-- =========================================================
-- 3. report_my_program() 은 재정의하지 않는다
--
--    자격 판정도(v_scope) 최소 길이도(v_min) 전부 report_reason_scope() 를 호출하므로
--    1번의 재정의만으로 새 규칙을 따른다. 같은 사실을 두 곳에 적지 않기 위해 손대지 않는다.
-- =========================================================

-- =========================================================
-- 적용 후 확인 (학생 세션, 참여하지 않은 프로그램에 대해)
--   1) select public.report_reason_scope('not_real');    -- 'open'
--   2) select public.report_reason_scope('other');       -- 'open'
--   3) select public.report_reason_scope('unpunctual');  -- 'participant'
--   4) report_my_program(<참여 안 한 프로그램>, 'not_real', <150자>)  -- {"ok": true}
--   5) report_my_program(<참여 안 한 프로그램>, 'unpunctual', <200자>) -- not_participant
--   6) npm run test:rls
-- =========================================================
