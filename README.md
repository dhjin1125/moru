# Moru

AI 모델을 연결해 대화하며 파일과 도구를 다루는 로컬 작업 공간.

**현재 상태:** 로컬 실행형 연구·개발 프로젝트

[제품 설명](https://nodeoff.kr/products/moru) · [소스 저장소](https://github.com/dhjin1125/moru)

## 개발 환경에서 실행

Node.js 26 이상

```sh
npm ci
npm start
```

브라우저에서 `http://127.0.0.1:4327`을 여세요. 모델 제공자를 연결한 뒤 새 대화를 시작합니다. 공개 체험 서버는 제공하지 않습니다. 모델 연결 방식에 따라 외부 서비스와 인터넷을 사용합니다. 포함된 외부 코드의 라이선스와 고지는 `src/providers/vendor/`에 있습니다.

## 운영자 정보

- 상호: 노드오프
- 대표: 진동현
- 사업자등록번호: 502-60-03676
- 운영 지역: 인천광역시
- 문의: [jin@nodeoff.kr](mailto:jin@nodeoff.kr)
- 회사 홈페이지: [nodeoff.kr](https://nodeoff.kr)

현재 개발 상태와 공개 주소는 회사 홈페이지와 함께 관리합니다.

## 공개 이력과 개발 경과

2026년 10월 7일 기존 비공개 작업을 정리해 처음 공개한 저장소입니다. 개발 시작일과 공개 커밋 날짜는 다릅니다. [개발 경과와 공개 범위](docs/development-history.md)를 확인해 주세요.

## 모델 연결 범위

코드에는 Anthropic messages 어댑터가 포함돼 있습니다. 어댑터 구현이 운영 환경의 Claude API 실사용·성능 검증을 뜻하지는 않습니다. 포함된 외부 코드의 라이선스·고지는 보존합니다. Nodeoff의 이번 Claude 도입 우선 제품은 [Nurse Board](https://nodeoff.kr/products/nurse-board#claude-plan)입니다.
