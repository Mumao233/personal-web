import { surveyStorageKeys } from "../src/survey-storage.js";

export function fakeSurveyLocks() {
  const owners = new Set();
  return {
    async request(name, options, callback) {
      if (owners.has(name)) return callback(null);
      owners.add(name);
      try {
        return await callback({ name });
      } finally {
        owners.delete(name);
      }
    },
  };
}

export function surveyRecords(storage, surveyId, kind) {
  const prefix = surveyStorageKeys(surveyId)[kind];
  return Array.from({ length: storage.length }, (_, index) =>
    storage.key(index),
  )
    .filter((key) => key.startsWith(prefix))
    .map((key) => JSON.parse(storage.getItem(key)));
}
