import { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Loader2, Search, Plus } from 'lucide-react';
import { bokbasen, books, type BokbasenSearchResult, type Book } from '../utils/api';
import { availabilityLabel } from '../utils/availabilityCodes';
import { toast } from 'sonner';

interface BokbasenOppslagProps {
  onBookAdded?: (book: Book) => void;
  allowedFormats?: Set<string>;
  isAvailabilityAllowed?: (code: string | null | undefined) => boolean;
}

export function BokbasenOppslag({ onBookAdded, allowedFormats, isAvailabilityAllowed }: BokbasenOppslagProps) {
  const [isbn, setIsbn] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [result, setResult] = useState<BokbasenSearchResult | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const handleSearch = async () => {
    const trimmed = isbn.trim().replace(/[^0-9Xx]/g, '');
    if (!trimmed) return;

    setIsSearching(true);
    setResult(null);
    try {
      const data = await bokbasen.fetchIsbn(trimmed);
      setResult(data);
    } catch (error) {
      toast.error('ISBN-oppslag feilet: ' + (error as Error).message);
    } finally {
      setIsSearching(false);
    }
  };

  const handleAdd = async () => {
    if (!result) return;
    setIsSaving(true);
    try {
      const saved = await books.upsert({
        isbn: result.isbn,
        title: result.title,
        author: result.author,
        publisher: result.publisher,
        year: result.year,
        format: result.format,
        price: result.price,
        description: result.description,
        image_url: result.imageUrl,
        genre: result.genre,
        bokgruppe: result.bokgruppe,
        vekt: result.vekt,
        availability_code: result.availability,
        availability_status: availabilityLabel(result.availability),
      });
      toast.success(`"${result.title}" lagt til i katalogen`);
      onBookAdded?.(saved);
      setResult(null);
      setIsbn('');
    } catch (error) {
      toast.error('Kunne ikke lagre: ' + (error as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="isbn-search">ISBN-nummer</Label>
        <div className="flex gap-2">
          <Input
            id="isbn-search"
            placeholder="9788205123456"
            value={isbn}
            onChange={(e) => setIsbn(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearch();
            }}
          />
          <Button onClick={handleSearch} disabled={isSearching}>
            {isSearching ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Search className="size-4" />
            )}
          </Button>
        </div>
      </div>

      {result && (() => {
        const formatBlocked = allowedFormats && result.format && !allowedFormats.has(result.format);
        const availabilityBlocked = isAvailabilityAllowed && !isAvailabilityAllowed(result.availability);
        const blocked = !!formatBlocked || !!availabilityBlocked;
        return (
          <div className={`border rounded-lg p-4 ${blocked ? 'bg-red-50 border-red-200' : 'bg-white'}`}>
            <div className="flex gap-4">
              {result.imageUrl && (
                <img
                  src={result.imageUrl}
                  alt={result.title}
                  className="w-16 h-24 object-cover rounded flex-shrink-0"
                />
              )}
              <div className="flex-1 min-w-0">
                <h3 className="font-medium">{result.title}</h3>
                <p className="text-sm text-gray-600">{result.author}</p>
                <p className="text-xs text-gray-500">
                  {result.publisher} {result.year && `· ${result.year}`} {result.format && `· ${result.format}`}
                </p>
                <p className="text-xs text-gray-500 font-mono mt-1">ISBN: {result.isbn}</p>
                {result.availability && (
                  <p className="text-xs text-gray-500 mt-1">
                    Tilgjengelighet: {availabilityLabel(result.availability)} (kode {result.availability})
                  </p>
                )}
                {result.price && (
                  <p className="text-sm font-medium mt-1">{result.price} kr</p>
                )}
                {formatBlocked && (
                  <p className="text-xs text-red-600 font-medium mt-1">
                    Formatet "{result.format}" er ikke tillatt i formatfilteret
                  </p>
                )}
                {availabilityBlocked && (
                  <p className="text-xs text-red-600 font-medium mt-1">
                    Tilgjengelighet "{availabilityLabel(result.availability)}" er ikke tillatt i tilgjengelighetsfilteret
                  </p>
                )}
              </div>
              <Button
                onClick={handleAdd}
                disabled={isSaving || blocked}
                className="flex-shrink-0 self-center"
              >
                {isSaving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <>
                    <Plus className="size-4 mr-1" />
                    Legg til
                  </>
                )}
              </Button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
