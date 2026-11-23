export type CityName = 'Lisbon' | 'Kyoto' | 'Copenhagen';
export type Activity = { id: string; name: string; category: string; tags: string[]; cost: number; durationHours: number; indoor: boolean; bestTime: string; diets: string[] };
type ActivityRow = [string, string, string, string, number, number, boolean, string, string?];

export const cities: Record<CityName, { allowance: number; activities: ActivityRow[] }> = {
  Lisbon: { allowance: 42, activities: [
    ['alfama','Alfama walking tour','culture','history,walking',18,2,false,'morning'], ['tile-museum','National Tile Museum','museum','art,history',8,2,true,'afternoon'], ['oceanarium','Lisbon Oceanarium','nature','family,nature',25,3,true,'afternoon'], ['pastel','Pastel de nata tasting','food','food,culture',9,1,true,'morning','vegetarian'], ['tram','Historic tram ride','sightseeing','photography,culture',7,1,false,'morning'], ['fado','Fado evening','music','music,culture',32,2,true,'evening'], ['belem','Belém riverside walk','walking','walking,history',0,2,false,'afternoon'], ['market','Time Out Market','food','food',16,1,true,'lunch','vegetarian,gluten-free'], ['viewpoint','São Jorge Castle viewpoint','history','history,photography',15,2,false,'afternoon'], ['bookshop','Bertrand bookshop visit','culture','books,culture',0,1,true,'morning'],
  ] },
  Kyoto: { allowance: 48, activities: [
    ['fushimi','Fushimi Inari shrine trail','culture','history,walking,nature',0,3,false,'morning'], ['tea','Traditional tea ceremony','culture','culture',28,2,true,'afternoon','vegetarian,vegan,gluten-free'], ['manga','Kyoto International Manga Museum','museum','art,books',12,2,true,'afternoon'], ['market','Nishiki Market tasting','food','food,culture',18,1,true,'lunch','vegetarian,gluten-free'], ['arashiyama','Arashiyama bamboo grove','nature','nature,walking',0,2,false,'morning'], ['temple','Kinkaku-ji temple','history','history,photography',5,2,false,'morning'], ['craft','Kiyomizu pottery workshop','craft','art,culture',35,2,true,'afternoon'], ['garden','Zen garden meditation','nature','nature,wellness',8,1,true,'morning'], ['river','Kamogawa riverside stroll','walking','walking,nature',0,1.5,false,'evening'], ['soba','Vegetarian soba lunch','food','food,vegetarian',14,1,true,'lunch','vegetarian,vegan'],
  ] },
  Copenhagen: { allowance: 55, activities: [
    ['design','Danish Design Museum','museum','design,art',15,2,true,'afternoon'], ['canal','Canal boat tour','sightseeing','water,photography',22,1,false,'morning'], ['tivoli','Tivoli Gardens','attraction','family,entertainment',24,3,false,'afternoon'], ['smorrebrod','Smørrebrød tasting','food','food,culture',20,1,true,'lunch','vegetarian'], ['library','Black Diamond library','architecture','architecture,books',0,1,true,'morning'], ['foodhall','Torvehallerne food hall','food','food',17,1,true,'lunch','vegetarian,gluten-free'], ['nyhavn','Nyhavn waterfront walk','walking','walking,photography',0,2,false,'afternoon'], ['glyptotek','Ny Carlsberg Glyptotek','museum','art,history',13,2,true,'afternoon'], ['bikes','City bike exploration','outdoors','cycling,walking',12,2,false,'morning'], ['planetarium','Tycho Brahe Planetarium','science','science,family',10,2,true,'evening'],
  ] },
};

export const supportedCities = Object.keys(cities) as CityName[];
export function resolveCity(destination: string): CityName | undefined {
  return supportedCities.find((city) => city.toLowerCase() === destination.trim().toLowerCase());
}
export function activitiesFor(city: CityName): Activity[] {
  return cities[city].activities.map(([id,name,category,tags,cost,durationHours,indoor,bestTime,diets]) => ({
    id, name, category, tags: tags.split(','), cost, durationHours, indoor, bestTime,
    diets: category === 'food' ? (diets ?? '').split(',').filter(Boolean) : ['vegetarian','vegan','gluten-free'],
  }));
}

export const flights: Record<CityName, Array<{ id: string; airline: string; price: number; stops: number; tier: string }>> = {
  Lisbon: [{ id:'lis-flight-saver',airline:'SkyWays',price:180,stops:1,tier:'saver' },{ id:'lis-flight-standard',airline:'EuroAir',price:280,stops:0,tier:'standard' },{ id:'lis-flight-flex',airline:'GlobalJet',price:420,stops:0,tier:'flex' }],
  Kyoto: [{ id:'kyo-flight-saver',airline:'AsiaConnect',price:420,stops:1,tier:'saver' },{ id:'kyo-flight-standard',airline:'Nippon Air',price:640,stops:0,tier:'standard' },{ id:'kyo-flight-flex',airline:'Pacific First',price:920,stops:0,tier:'flex' }],
  Copenhagen: [{ id:'cph-flight-saver',airline:'NordicHop',price:160,stops:1,tier:'saver' },{ id:'cph-flight-standard',airline:'Scandi Air',price:240,stops:0,tier:'standard' },{ id:'cph-flight-flex',airline:'CrownJet',price:390,stops:0,tier:'flex' }],
};
export const lodgings: Record<CityName, Array<{ id: string; name: string; neighborhood: string; nightlyRate: number; tier: string }>> = {
  Lisbon: [{id:'lisbon-budget',name:'Casa do Bairro',neighborhood:'Graça',nightlyRate:55,tier:'budget'},{id:'lisbon-mid',name:'Riverlight Hotel',neighborhood:'Baixa',nightlyRate:105,tier:'mid'},{id:'lisbon-comfort',name:'Palácio Azul',neighborhood:'Chiado',nightlyRate:190,tier:'comfort'}],
  Kyoto: [{id:'kyoto-budget',name:'Maple Guesthouse',neighborhood:'Higashiyama',nightlyRate:48,tier:'budget'},{id:'kyoto-mid',name:'Sakura House',neighborhood:'Gion',nightlyRate:98,tier:'mid'},{id:'kyoto-comfort',name:'Kumo Ryokan',neighborhood:'Arashiyama',nightlyRate:175,tier:'comfort'}],
  Copenhagen: [{id:'cph-budget',name:'Canal Corner Hostel',neighborhood:'Nørrebro',nightlyRate:85,tier:'budget'},{id:'cph-mid',name:'Harbor House',neighborhood:'Vesterbro',nightlyRate:145,tier:'mid'},{id:'cph-comfort',name:'Royal Nord Hotel',neighborhood:'Indre By',nightlyRate:230,tier:'comfort'}],
};

export function weatherForDates(destination: string, startDate: string, endDate: string) {
  const city = resolveCity(destination);
  if (!city) return undefined;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  const dates: string[] = [];
  for (let time = start; time <= end; time += 86_400_000) dates.push(new Date(time).toISOString().slice(0, 10));
  const cityOffset = supportedCities.indexOf(city) * 13;
  return dates.map((date, index) => {
    const dayOffset = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
    const rainChance = (dayOffset * 17 + cityOffset) % 100;
    const rainy = rainChance >= 50;
    return { date, condition: rainy ? (rainChance >= 75 ? 'Rain' : 'Showers') : (rainChance >= 25 ? 'Cloudy' : 'Sunny'), high: 17 + ((index + cityOffset) % 7), low: 10 + ((index + cityOffset) % 4), rainChance, rainy };
  });
}
