// Mock data for utvikling og testing

export interface Book {
  isbn: string;
  title: string;
  author: string;
  publisher: string;
  image_url: string;
  price?: number;
  format?: string;
  availability?: string;
}

export const mockBooks: Book[] = [
  {
    isbn: '9788205522695',
    title: 'Min kamp 1',
    author: 'Karl Ove Knausgård',
    publisher: 'Oktober',
    image_url: 'https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=400&h=600&fit=crop',
    price: 399,
    format: 'Innbundet',
    availability: 'På lager'
  },
  {
    isbn: '9788203195518',
    title: 'Tante Ulrikkes vei',
    author: 'Zeshan Shakar',
    publisher: 'Gyldendal',
    image_url: 'https://images.unsplash.com/photo-1543002588-bfa74002ed7e?w=400&h=600&fit=crop',
    price: 349,
    format: 'Pocket',
    availability: 'På lager'
  },
  {
    isbn: '9788205554344',
    title: 'Doppler',
    author: 'Erlend Loe',
    publisher: 'Cappelen Damm',
    image_url: 'https://images.unsplash.com/photo-1512820790803-83ca734da794?w=400&h=600&fit=crop',
    price: 299,
    format: 'Pocket',
    availability: 'På lager'
  },
  {
    isbn: '9788205505414',
    title: 'Naiv. Super',
    author: 'Erlend Loe',
    publisher: 'Cappelen Damm',
    image_url: 'https://images.unsplash.com/photo-1589998059171-988d887df646?w=400&h=600&fit=crop',
    price: 329,
    format: 'Pocket',
    availability: 'På lager'
  },
  {
    isbn: '9788205366213',
    title: 'Beatles',
    author: 'Lars Saabye Christensen',
    publisher: 'Cappelen Damm',
    image_url: 'https://images.unsplash.com/photo-1519682337058-a94d519337bc?w=400&h=600&fit=crop',
    price: 379,
    format: 'Innbundet',
    availability: 'På lager'
  },
  {
    isbn: '9788205407947',
    title: 'Uke 53',
    author: 'Sven Egil Omdal',
    publisher: 'Aschehoug',
    image_url: 'https://images.unsplash.com/photo-1481627834876-b7833e8f5570?w=400&h=600&fit=crop',
    price: 399,
    format: 'Innbundet',
    availability: 'Forhåndsbestilling'
  },
  {
    isbn: '9788205493704',
    title: 'Hitlers helvete',
    author: 'Arne Svingen',
    publisher: 'Gyldendal',
    image_url: 'https://images.unsplash.com/photo-1457369804613-52c61a468e7d?w=400&h=600&fit=crop',
    price: 349,
    format: 'Innbundet',
    availability: 'På lager'
  },
  {
    isbn: '9788205522701',
    title: 'Min kamp 2',
    author: 'Karl Ove Knausgård',
    publisher: 'Oktober',
    image_url: 'https://images.unsplash.com/photo-1550399105-c4db5fb85c18?w=400&h=600&fit=crop',
    price: 399,
    format: 'Innbundet',
    availability: 'På lager'
  },
  {
    isbn: '9788205554351',
    title: 'Fakta om Finland',
    author: 'Erlend Loe',
    publisher: 'Cappelen Damm',
    image_url: 'https://images.unsplash.com/photo-1524578271613-d550eacf6090?w=400&h=600&fit=crop',
    price: 299,
    format: 'Pocket',
    availability: 'På lager'
  },
  {
    isbn: '9788205407954',
    title: 'Søndagsengler',
    author: 'Hanne Ørstavik',
    publisher: 'Oktober',
    image_url: 'https://images.unsplash.com/photo-1506880018603-83d5b814b5a6?w=400&h=600&fit=crop',
    price: 329,
    format: 'Pocket',
    availability: 'På lager'
  },
  {
    isbn: '9788205493711',
    title: 'Smerte',
    author: 'Zeshan Shakar',
    publisher: 'Gyldendal',
    image_url: 'https://images.unsplash.com/photo-1516979187457-637abb4f9353?w=400&h=600&fit=crop',
    price: 379,
    format: 'Innbundet',
    availability: 'Forhåndsbestilling'
  },
  {
    isbn: '9788203366220',
    title: 'Verden og meg',
    author: 'Johan Harstad',
    publisher: 'Gyldendal',
    image_url: 'https://images.unsplash.com/photo-1497633762265-9d179a990aa6?w=400&h=600&fit=crop',
    price: 449,
    format: 'Innbundet',
    availability: 'På lager'
  },
  {
    isbn: '9788205522718',
    title: 'Heimebane',
    author: 'Gunnhild Øyehaug',
    publisher: 'Oktober',
    image_url: 'https://images.unsplash.com/photo-1495446815901-a7297e633e8d?w=400&h=600&fit=crop',
    price: 349,
    format: 'Innbundet',
    availability: 'På lager'
  },
  {
    isbn: '9788205554368',
    title: 'Volvo lastvagnar',
    author: 'Erlend Loe',
    publisher: 'Cappelen Damm',
    image_url: 'https://images.unsplash.com/photo-1532012197267-da84d127e765?w=400&h=600&fit=crop',
    price: 299,
    format: 'Pocket',
    availability: 'På lager'
  },
  {
    isbn: '9788205493728',
    title: 'De usynlige',
    author: 'Roy Jacobsen',
    publisher: 'Cappelen Damm',
    image_url: 'https://images.unsplash.com/photo-1551029506-0807df4e1e3a?w=400&h=600&fit=crop',
    price: 399,
    format: 'Innbundet',
    availability: 'På lager'
  },
  {
    isbn: '9788203366237',
    title: 'Hjemsøkt',
    author: 'Vigdis Hjorth',
    publisher: 'Cappelen Damm',
    image_url: 'https://images.unsplash.com/photo-1507842217343-583bb7270b66?w=400&h=600&fit=crop',
    price: 379,
    format: 'Innbundet',
    availability: 'Forhåndsbestilling'
  }
];

export interface Feed {
  id: string;
  title: string;
  shopify_collection?: string;
  created_at: string;
  books: Book[];
}

export const mockFeeds: Feed[] = [
  {
    id: '1',
    title: 'Anbefalinger',
    shopify_collection: 'anbefalinger',
    created_at: '2026-02-15T10:00:00Z',
    books: [
      mockBooks[0],
      mockBooks[2],
      mockBooks[4],
      mockBooks[6],
      mockBooks[8],
      mockBooks[10],
    ]
  },
  {
    id: '2',
    title: 'Nyheter',
    shopify_collection: 'nyheter',
    created_at: '2026-02-18T14:30:00Z',
    books: [
      mockBooks[5],
      mockBooks[10],
      mockBooks[15],
    ]
  },
  {
    id: '3',
    title: 'Forhåndssalg',
    shopify_collection: 'preorder',
    created_at: '2026-02-20T09:15:00Z',
    books: [
      mockBooks[5],
      mockBooks[10],
      mockBooks[15],
    ]
  },
  {
    id: '4',
    title: 'Bestselgere',
    created_at: '2026-02-19T16:45:00Z',
    books: [
      mockBooks[0],
      mockBooks[1],
      mockBooks[4],
      mockBooks[7],
      mockBooks[12],
    ]
  },
];

// Helper function to get random books
export function getRandomBooks(count: number): Book[] {
  const shuffled = [...mockBooks].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

// Helper function to find book by ISBN
export function findBookByIsbn(isbn: string): Book | undefined {
  return mockBooks.find(b => b.isbn === isbn);
}
