import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Plus } from 'lucide-react';
import { Import } from './Import';
import { Oppdatering } from './Oppdatering';
import { Sjangre } from './Sjangre';
import { ShopifyKatalog } from './ShopifyKatalog';
import { Innstillinger } from './Innstillinger';
import Feeder from './Feeder';

interface ContentAreaProps {
  activeItem: string;
}

export function ContentArea({ activeItem }: ContentAreaProps) {
  const renderContent = () => {
    switch (activeItem) {
      case 'innstillinger':
        return <Innstillinger />;

      case 'import':
        return <Import />;

      case 'update':
        return <Oppdatering />;

      case 'genres':
        return <Sjangre />;

      case 'katalog':
        return <ShopifyKatalog />;

      case 'feeds':
        return <Feeder />;

      case 'cms':
        return (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Legg til reklame-hero</CardTitle>
                <CardDescription>Opprett en ny hero-seksjon basert på bok eller kolleksjon</CardDescription>
              </CardHeader>
              <CardContent>
                <Button>
                  <Plus className="size-4 mr-2" />
                  Ny reklame-hero
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Legg til blogginnlegg</CardTitle>
                <CardDescription>Opprett et nytt blogginnlegg</CardDescription>
              </CardHeader>
              <CardContent>
                <Button>
                  <Plus className="size-4 mr-2" />
                  Nytt blogginnlegg
                </Button>
              </CardContent>
            </Card>
          </div>
        );

      default:
        return (
          <Card>
            <CardHeader>
              <CardTitle>Velg en menyvalg</CardTitle>
              <CardDescription>Bruk menyen til venstre for å navigere</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-600">
                Velg et element fra menyen for å komme i gang med å administrere bokdatabasen din.
              </p>
            </CardContent>
          </Card>
        );
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50">
      <div className="max-w-4xl mx-auto p-8">
        {renderContent()}
      </div>
    </div>
  );
}
