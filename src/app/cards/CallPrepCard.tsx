import { useState } from 'react';
import {
  hubspot,
  Button,
  Flex,
  Heading,
  Text,
  LoadingSpinner,
  ErrorState,
  EmptyState,
  Tile,
  DescriptionList,
  DescriptionListItem,
} from '@hubspot/ui-extensions';

type Brief = {
  synthese: string;
  etat: string;
  points_ouverts: string[];
  questions: string[];
  a_eviter: string[];
};

hubspot.extend<'crm.record.tab'>(({ context, runServerlessFunction }) => (
  <CallPrepCard context={context} runServerless={runServerlessFunction} />
));

const CallPrepCard = ({ context, runServerless }: any) => {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await runServerless({
        name: 'generate_call_brief',
        parameters: { contactId: context.crm.objectId },
      });
      if (res.status === 'SUCCESS') {
        setBrief(res.response.brief);
      } else {
        setError(res.message || 'Erreur inconnue');
      }
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <LoadingSpinner label="Génération du brief en cours…" />;

  if (error)
    return (
      <ErrorState title="Impossible de générer le brief" layout="vertical">
        <Text>{error}</Text>
        <Button onClick={generate}>Réessayer</Button>
      </ErrorState>
    );

  if (!brief)
    return (
      <EmptyState title="Brief de call" layout="vertical" imageName="resources">
        <Text>Génère un brief contextualisé pour préparer ton prochain call avec ce contact.</Text>
        <Button variant="primary" onClick={generate}>
          Générer le brief
        </Button>
      </EmptyState>
    );

  return (
    <Flex direction="column" gap="md">
      <Tile>
        <Heading>Synthèse</Heading>
        <Text>{brief.synthese}</Text>
      </Tile>
      <Tile>
        <Heading>Où on en est</Heading>
        <Text>{brief.etat}</Text>
      </Tile>
      <Tile>
        <Heading>Points ouverts</Heading>
        <DescriptionList direction="column">
          {brief.points_ouverts.map((p, i) => (
            <DescriptionListItem key={i} label={`#${i + 1}`}>
              {p}
            </DescriptionListItem>
          ))}
        </DescriptionList>
      </Tile>
      <Tile>
        <Heading>Questions à poser</Heading>
        <DescriptionList direction="column">
          {brief.questions.map((q, i) => (
            <DescriptionListItem key={i} label={`Q${i + 1}`}>
              {q}
            </DescriptionListItem>
          ))}
        </DescriptionList>
      </Tile>
      <Tile>
        <Heading>À éviter</Heading>
        <DescriptionList direction="column">
          {brief.a_eviter.map((a, i) => (
            <DescriptionListItem key={i} label={`!`}>
              {a}
            </DescriptionListItem>
          ))}
        </DescriptionList>
      </Tile>
      <Flex gap="sm">
        <Button onClick={generate}>Régénérer</Button>
      </Flex>
    </Flex>
  );
};
