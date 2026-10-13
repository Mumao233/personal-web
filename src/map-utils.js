export function distanceKm(a, b) {
  const rad = (degrees) => (Number(degrees) * Math.PI) / 180;
  const lat1 = rad(a.lat),
    lat2 = rad(b.lat);
  const angle =
    Math.sin((lat2 - lat1) / 2) ** 2 +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(rad(Number(b.lng) - Number(a.lng)) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, angle))));
}

export function cluster(stories, far) {
  if (!far)
    return stories.map((story) => ({ ...story, items: [story], count: 1 }));
  const groups = [];
  for (const story of stories) {
    // City names are not globally unique. Only actual nearby coordinates cluster.
    let group = groups.find((entry) => distanceKm(story, entry.items[0]) < 60);
    if (!group) {
      group = {
        ...story,
        lat: Number(story.lat),
        lng: Number(story.lng),
        items: [],
        count: 0,
      };
      groups.push(group);
    }
    group.items.push(story);
    group.count++;
  }
  return groups;
}
