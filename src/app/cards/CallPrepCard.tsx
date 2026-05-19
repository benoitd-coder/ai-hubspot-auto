import { useState } from 'react';
import {
  hubspot,
  Button,
  Flex,
  Heading,
  Text,
  LoadingSpinner,
  Alert,
  EmptyState,
  Tile,
  List,
} from '@hubspot/ui-extensions';

type Brief = {
  synthese: string;
  etat: string;
  points_ouverts: string[];
  questions: string[];
  a_eviter: string[];
};

hubspot.extend<'crm.record.sidebar'>(({ context, runServerlessFunction }) => (
  <CallPrepCard context={context} runServerless={runServerlessFunction} />
));

const CallPrepCard = ({ context, runServerless }: any) => {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);

  const objectId = context?.crm?.objectId ?? context?.objectId;
  const objectTypeId = context?.crm?.objectTypeId ?? context?.objectTypeId;
  const objectType = context?.crm?.objectType ?? context?.objectType;

  const generate = async (force = false) => {
    setLoading(true);
    setError(null);
    setStatusText('Lancement de la génération…');
    try {
      const start = await runServerless({
        name: 'generate_call_brief',
        parameters: { action: 'start', objectId, objectTypeId, objectType, contactId: objectId, force },
      });

      const startPayload = start?.response ?? start;
      if (startPayload?.error) {
        setError(startPayload.error);
        return;
      }

      if (startPayload?.brief) {
        setBrief(startPayload.brief);
        setStatusText(startPayload.source === 'cache' ? 'Brief récupéré depuis le cache.' : null);
        return;
      }

      const jobId = startPayload?.jobId;
      if (!jobId) {
        setError('Réponse inattendue du worker de brief.');
        return;
      }

      setStatusText('Brief en cours de génération…');
      const result = await pollJob(jobId);
      if (result?.brief) {
        setBrief(result.brief);
        setStatusText(null);
      } else {
        setError(result?.error || 'La génération du brief n’a pas abouti.');
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const pollJob = async (jobId: string) => {
    for (let i = 0; i < 45; i += 1) {
      await wait(2000);
      const res = await runServerless({
        name: 'generate_call_brief',
        parameters: { action: 'status', jobId },
      });
      const payload = res?.response ?? res;
      if (payload?.status === 'done' || payload?.status === 'error') {
        return payload;
      }
      setStatusText(payload?.status === 'running' ? 'Gemini prépare le brief complet…' : 'Brief en file d’attente…');
    }
    return { error: 'La génération prend trop de temps. Réessaie dans quelques instants.' };
  };

  return (
    <Flex direction="column" gap="md">
      {loading && <LoadingSpinner label="Génération du brief en cours…" />}

      {statusText && !error && <Text variant="microcopy">{statusText}</Text>}

      {error && (
        <Alert title="Erreur" variant="error">
          <Text>{error}</Text>
        </Alert>
      )}

      {!loading && !brief && !error && (
        <EmptyState title="Brief de call" layout="vertical" imageName="resources">
          <Text>Génère un brief contextualisé à partir des données CRM de cette fiche.</Text>
        </EmptyState>
      )}

      {brief && (
        <>
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
            <List variant="unordered-styled">
              {brief.points_ouverts.map((p, i) => (
                <Text key={i}>{p}</Text>
              ))}
            </List>
          </Tile>
          <Tile>
            <Heading>Questions à poser</Heading>
            <List variant="ordered-styled">
              {brief.questions.map((q, i) => (
                <Text key={i}>{q}</Text>
              ))}
            </List>
          </Tile>
          <Tile>
            <Heading>À éviter</Heading>
            <List variant="unordered-styled">
              {brief.a_eviter.map((a, i) => (
                <Text key={i}>{a}</Text>
              ))}
            </List>
          </Tile>
        </>
      )}

      <Button variant="primary" onClick={() => generate(Boolean(brief))} disabled={loading}>
        {brief ? 'Régénérer le brief' : 'Générer le brief'}
      </Button>
    </Flex>
  );
};

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
