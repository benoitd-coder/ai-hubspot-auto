// Sales Copilot — generate-call-brief
// Étape 1 (mock) : retourne un brief factice pour valider le wiring HubSpot.
// Étape 2 : remplacement par un appel Gemini 2.5 Flash + récupération du contexte HubSpot réel.

exports.main = async (context = {}) => {
  const { contactId } = context.parameters || {};

  // Mock — sera remplacé par un appel Gemini avec le contexte HubSpot réel.
  const brief = {
    synthese: `Brief mock pour le contact ${contactId}. Le wiring fonctionne, prochaine étape : brancher Gemini.`,
    etat: 'Stage actuel inconnu (mock). Dernier point clé à venir une fois le contexte HubSpot récupéré.',
    points_ouverts: [
      'Aucun point ouvert détecté (mock).',
      'À enrichir avec les notes des 5 dernières interactions.',
    ],
    questions: [
      'Quelle est la priorité actuelle sur la couverture santé ?',
      'Quel est le calendrier de décision côté direction ?',
      'Y a-t-il un courtier en place aujourd\'hui ?',
    ],
    a_eviter: [
      'Aucun sujet sensible détecté (mock).',
    ],
  };

  return { brief };
};
