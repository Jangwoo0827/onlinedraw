/** 서버 시각 추정. Firebase 의 .info/serverTimeOffset 을 받으면 setOffset 으로 맞춘다. */
let offset = 0;

export const setServerOffset = (ms: number) => {
  offset = ms;
};

export const serverNow = () => Date.now() + offset;
